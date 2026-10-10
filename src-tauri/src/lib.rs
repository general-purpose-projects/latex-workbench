use blake3::Hasher;
use ignore::{DirEntry, WalkBuilder};
use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{ExitStatus, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU32, Ordering},
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
    time::timeout,
};
use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

const BUILD_DIR: &str = ".latex-workbench";
const MAX_PROJECT_FILES: usize = 10_000;
const BUILD_PIPELINE_VERSION: &[u8] = b"3-external-cache-and-svg-artifacts";

struct TerminalSession {
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

#[derive(Default)]
struct TerminalState {
    next_id: AtomicU32,
    sessions: Mutex<HashMap<u32, TerminalSession>>,
}

#[derive(Clone, Serialize)]
struct TerminalOutput {
    id: u32,
    data: String,
}

#[derive(Debug, thiserror::Error)]
enum AppError {
    #[error("Ruta inválida: {0}")]
    InvalidPath(String),
    #[error("Motor no disponible: {0}")]
    EngineUnavailable(String),
    #[error("La compilación excedió el límite de tiempo")]
    Timeout,
    #[error("{0}")]
    Message(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Zip(#[from] zip::result::ZipError),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EngineInfo {
    id: &'static str,
    label: &'static str,
    available: bool,
    path: Option<String>,
    version: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectFile {
    path: String,
    name: String,
    kind: &'static str,
    depth: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectInfo {
    root: String,
    name: String,
    files: Vec<ProjectFile>,
    documents: Vec<String>,
    git_branch: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BuildRequest {
    project_root: String,
    document: String,
    engine: String,
    shell_escape: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Diagnostic {
    severity: &'static str,
    message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BuildResult {
    success: bool,
    cached: bool,
    duration_ms: u128,
    pdf_path: Option<String>,
    log: String,
    diagnostics: Vec<Diagnostic>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BuildLogChunk {
    data: String,
    stream: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceLocation {
    path: String,
    line: usize,
    column: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitResult {
    success: bool,
    output: String,
}

fn ignored_entry(entry: &DirEntry) -> bool {
    let name = entry.file_name().to_string_lossy();
    !(name == ".git"
        || name == BUILD_DIR
        || name == "svg-inkscape"
        || name == "node_modules"
        || name == "target"
        || name == ".DS_Store")
}

fn canonical_root(root: &str) -> Result<PathBuf, AppError> {
    let path = fs::canonicalize(root)?;
    if !path.is_dir() {
        return Err(AppError::InvalidPath(root.to_string()));
    }
    Ok(path)
}

fn project_path(root: &Path, relative: &str) -> Result<PathBuf, AppError> {
    let candidate = root.join(relative);
    let canonical = fs::canonicalize(&candidate)?;
    if !canonical.starts_with(root) || !canonical.is_file() {
        return Err(AppError::InvalidPath(relative.to_string()));
    }
    Ok(canonical)
}

fn executable_candidates(name: &str) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path).map(|dir| dir.join(name)));
    }
    for directory in [
        "/Library/TeX/texbin",
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
    ] {
        candidates.push(Path::new(directory).join(name));
    }
    candidates
}

fn find_executable(name: &str) -> Option<PathBuf> {
    executable_candidates(name)
        .into_iter()
        .find(|candidate| candidate.is_file())
}

fn project_build_dir(
    root: &Path,
    app: Option<&tauri::AppHandle>,
) -> Result<PathBuf, AppError> {
    if let Some(app) = app {
        let mut hasher = Hasher::new();
        hasher.update(root.to_string_lossy().as_bytes());
        let project_key = hasher.finalize().to_hex().to_string();
        return Ok(app
            .path()
            .app_cache_dir()
            .map_err(|error| AppError::Message(error.to_string()))?
            .join("projects")
            .join(project_key)
            .join("build"));
    }
    Ok(root.join(BUILD_DIR).join("build"))
}

fn remove_cache_path(path: &Path) -> Result<(), AppError> {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() || metadata.is_file() {
            fs::remove_file(path)?;
        } else {
            fs::remove_dir_all(path)?;
        }
    }
    Ok(())
}

async fn command_version(path: &Path) -> Option<String> {
    let output = Command::new(path).arg("--version").output().await.ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines()
        .next()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToOwned::to_owned)
}

#[tauri::command]
async fn list_engines() -> Vec<EngineInfo> {
    let definitions = [
        ("latexmk", "LaTeXmk", "latexmk"),
        ("lualatex", "LuaLaTeX", "lualatex"),
        ("xelatex", "XeLaTeX", "xelatex"),
        ("pdflatex", "pdfLaTeX", "pdflatex"),
        ("tectonic", "Tectonic", "tectonic"),
    ];
    let mut engines = Vec::new();
    for (id, label, binary) in definitions {
        let path = find_executable(binary);
        let version = match &path {
            Some(path) => command_version(path).await,
            None => None,
        };
        engines.push(EngineInfo {
            id,
            label,
            available: path.is_some(),
            path: path.map(|path| path.to_string_lossy().into_owned()),
            version,
        });
    }
    engines
}

#[tauri::command]
fn discover_project(root: String) -> Result<ProjectInfo, AppError> {
    let root = canonical_root(&root)?;
    let mut files = Vec::new();
    let mut documents = Vec::new();
    let walker = WalkBuilder::new(&root)
        .hidden(false)
        .git_ignore(false)
        .git_exclude(false)
        .filter_entry(ignored_entry)
        .build();

    for result in walker
        .filter_map(Result::ok)
        .skip(1)
        .take(MAX_PROJECT_FILES)
    {
        let path = result.path();
        let Ok(relative) = path.strip_prefix(&root) else {
            continue;
        };
        let relative_string = relative.to_string_lossy().replace('\\', "/");
        let kind = if path.is_dir() { "directory" } else { "file" };
        if path.extension().and_then(|ext| ext.to_str()) == Some("tex")
            && path.is_file()
            && let Ok(mut file) = fs::File::open(path)
        {
            let mut buffer = String::new();
            let _ = std::io::Read::by_ref(&mut file)
                .take(128 * 1024)
                .read_to_string(&mut buffer);
            if buffer.contains("\\documentclass") {
                documents.push(relative_string.clone());
            }
        }
        files.push(ProjectFile {
            path: relative_string,
            name: result.file_name().to_string_lossy().into_owned(),
            kind,
            depth: relative.components().count().saturating_sub(1),
        });
    }
    files.sort_by_key(|item| item.path.to_lowercase());
    documents.sort();

    let git_branch = std::process::Command::new("git")
        .args(["-C", &root.to_string_lossy(), "branch", "--show-current"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| {
            let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
            (!value.is_empty()).then_some(value)
        });

    Ok(ProjectInfo {
        name: root
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("Proyecto")
            .to_string(),
        root: root.to_string_lossy().into_owned(),
        files,
        documents,
        git_branch,
    })
}

#[tauri::command]
fn read_project_file(project_root: String, path: String) -> Result<String, AppError> {
    let root = canonical_root(&project_root)?;
    let path = project_path(&root, &path)?;
    fs::read_to_string(path).map_err(AppError::from)
}

#[tauri::command]
fn read_project_asset(
    project_root: String,
    path: String,
) -> Result<tauri::ipc::Response, AppError> {
    let root = canonical_root(&project_root)?;
    let path = project_path(&root, &path)?;
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !["png", "jpg", "jpeg", "gif", "webp", "svg"].contains(&extension.as_str()) {
        return Err(AppError::InvalidPath(path.to_string_lossy().into_owned()));
    }
    Ok(tauri::ipc::Response::new(fs::read(path)?))
}

#[tauri::command]
fn import_project_image(project_root: String, source: String) -> Result<String, AppError> {
    let root = canonical_root(&project_root)?;
    let source = fs::canonicalize(source)?;
    if !source.is_file() {
        return Err(AppError::InvalidPath(source.to_string_lossy().into_owned()));
    }
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !["png", "jpg", "jpeg", "gif", "webp", "svg"].contains(&extension.as_str()) {
        return Err(AppError::Message("El formato de imagen no es compatible".into()));
    }

    let images = root.join("images");
    fs::create_dir_all(&images)?;
    if source.parent() == Some(images.as_path()) {
        return source
            .strip_prefix(&root)
            .map(|value| value.to_string_lossy().replace('\\', "/"))
            .map_err(|_| AppError::InvalidPath(source.to_string_lossy().into_owned()));
    }

    let stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("imagen");
    let mut destination = images.join(format!("{stem}.{extension}"));
    let mut suffix = 2;
    while destination.exists() {
        destination = images.join(format!("{stem}-{suffix}.{extension}"));
        suffix += 1;
    }
    fs::copy(&source, &destination)?;
    destination
        .strip_prefix(&root)
        .map(|value| value.to_string_lossy().replace('\\', "/"))
        .map_err(|_| AppError::InvalidPath(destination.to_string_lossy().into_owned()))
}

#[tauri::command]
fn default_download_path(app: tauri::AppHandle, file_name: String) -> Result<String, AppError> {
    let safe_name = Path::new(&file_name)
        .file_name()
        .ok_or_else(|| AppError::InvalidPath(file_name.clone()))?;
    let downloads = app
        .path()
        .download_dir()
        .map_err(|error| AppError::Message(error.to_string()))?;
    Ok(downloads.join(safe_name).to_string_lossy().into_owned())
}

#[tauri::command]
fn write_project_file(project_root: String, path: String, content: String) -> Result<(), AppError> {
    let root = canonical_root(&project_root)?;
    let path = project_path(&root, &path)?;
    fs::write(path, content).map_err(AppError::from)
}

fn dependency_paths(root: &Path, dependency_file: &Path) -> Vec<PathBuf> {
    if let Ok(contents) = fs::read_to_string(dependency_file)
        && let Ok(relative_paths) = serde_json::from_str::<Vec<String>>(&contents)
    {
        let paths: Vec<_> = relative_paths
            .into_iter()
            .map(|relative| root.join(relative))
            .filter(|path| path.is_file())
            .collect();
        if !paths.is_empty() {
            return paths;
        }
    }

    WalkBuilder::new(root)
        .hidden(false)
        .git_ignore(false)
        .git_exclude(false)
        .filter_entry(ignored_entry)
        .build()
        .filter_map(Result::ok)
        .map(|entry| entry.into_path())
        .filter(|path| path.is_file())
        .collect()
}

fn project_fingerprint(
    root: &Path,
    request: &BuildRequest,
    dependency_file: &Path,
) -> Result<String, AppError> {
    let mut paths = dependency_paths(root, dependency_file);
    paths.sort();
    let mut hasher = Hasher::new();
    hasher.update(BUILD_PIPELINE_VERSION);
    hasher.update(request.document.as_bytes());
    hasher.update(request.engine.as_bytes());
    hasher.update(&[request.shell_escape as u8]);
    if let Some(engine) = find_executable(&request.engine) {
        hasher.update(engine.to_string_lossy().as_bytes());
        if let Ok(metadata) = engine.metadata() {
            hasher.update(&metadata.len().to_le_bytes());
            if let Ok(modified) = metadata.modified()
                && let Ok(elapsed) = modified.duration_since(std::time::UNIX_EPOCH)
            {
                hasher.update(&elapsed.as_secs().to_le_bytes());
            }
        }
    }
    for path in paths {
        if let Ok(relative) = path.strip_prefix(root) {
            hasher.update(relative.to_string_lossy().as_bytes());
            if let Ok(data) = fs::read(path) {
                hasher.update(&data);
            }
        }
    }
    Ok(hasher.finalize().to_hex().to_string())
}

fn save_dependencies(root: &Path, fls_path: &Path, destination: &Path) -> Result<(), AppError> {
    let contents = match fs::read_to_string(fls_path) {
        Ok(contents) => contents,
        Err(_) => return Ok(()),
    };
    let mut dependencies = Vec::new();
    for line in contents
        .lines()
        .filter_map(|line| line.strip_prefix("INPUT "))
    {
        let raw = Path::new(line);
        let candidate = if raw.is_absolute() {
            raw.to_path_buf()
        } else {
            root.join(raw)
        };
        let Ok(canonical) = fs::canonicalize(candidate) else {
            continue;
        };
        if canonical.starts_with(root)
            && canonical.is_file()
            && let Ok(relative) = canonical.strip_prefix(root)
        {
            dependencies.push(relative.to_string_lossy().replace('\\', "/"));
        }
    }
    dependencies.sort();
    dependencies.dedup();
    if !dependencies.is_empty() {
        fs::write(destination, serde_json::to_vec_pretty(&dependencies)?)?;
    }
    Ok(())
}

fn build_command(
    request: &BuildRequest,
    output_dir: &Path,
    document_path: &Path,
) -> Result<(PathBuf, Vec<String>), AppError> {
    let engine_path = find_executable(&request.engine)
        .ok_or_else(|| AppError::EngineUnavailable(request.engine.clone()))?;
    let output = output_dir.to_string_lossy().into_owned();
    let document = document_path.to_string_lossy().into_owned();
    let svg_output = output_dir
        .join("svg-inkscape")
        .to_string_lossy()
        .replace('\\', "/")
        + "/";
    let svg_pretex = format!(
        "-usepretex=\\PassOptionsToPackage{{inkscapepath={{{svg_output}}}}}{{svg}}"
    );

    if request.engine == "tectonic" {
        return Ok((
            engine_path,
            vec![
                document,
                "--outdir".into(),
                output,
                "--synctex".into(),
                "--keep-logs".into(),
                "--keep-intermediates".into(),
            ],
        ));
    }

    if request.engine == "latexmk" {
        let mut args = vec![
            "-pdf".into(),
            "-interaction=nonstopmode".into(),
            "-file-line-error".into(),
            "-synctex=1".into(),
            "-recorder".into(),
            format!("-outdir={output}"),
            svg_pretex.clone(),
        ];
        if request.shell_escape {
            args.push("-shell-escape".into());
        }
        args.push(document);
        return Ok((engine_path, args));
    }

    // Latexmk reuses the shared auxiliary files and only runs tools whose
    // inputs changed.  It still converges every build completely: references
    // get the required extra TeX passes, and bibliographies run Biber or
    // BibTeX before the final pass whenever their inputs require it.
    if let Some(latexmk) = find_executable("latexmk") {
        let mode = match request.engine.as_str() {
            "lualatex" => "-lualatex",
            "xelatex" => "-xelatex",
            _ => "-pdf",
        };
        let mut args = vec![
            mode.into(),
            "-interaction=nonstopmode".into(),
            "-file-line-error".into(),
            "-synctex=1".into(),
            "-recorder".into(),
            format!("-outdir={output}"),
            svg_pretex,
        ];
        if request.shell_escape {
            args.push("-shell-escape".into());
        }
        args.push(document);
        return Ok((latexmk, args));
    }

    let mut args = vec![
        "-interaction=nonstopmode".into(),
        "-file-line-error".into(),
        "-synctex=1".into(),
        "-recorder".into(),
        format!("-output-directory={output}"),
    ];
    if request.shell_escape {
        args.push("-shell-escape".into());
    }
    args.push(document);
    Ok((engine_path, args))
}

#[cfg(unix)]
fn compatible_latexminted_runtime() -> Option<(PathBuf, PathBuf)> {
    let latexminted = find_executable("latexminted")?;
    ["python3.13", "python3.12", "python3.11"]
        .into_iter()
        .filter_map(find_executable)
        .find(|python| {
            std::process::Command::new(python)
                .arg(&latexminted)
                .arg("--version")
                .output()
                .map(|output| output.status.success())
                .unwrap_or(false)
        })
        .map(|python| (python, latexminted))
}

#[cfg(unix)]
fn configure_runtime_compatibility(
    command: &mut Command,
    root: &Path,
    app: Option<&tauri::AppHandle>,
) -> Result<(), AppError> {
    use std::os::unix::fs::PermissionsExt;

    let bin_dir = app
        .and_then(|app| app.path().app_cache_dir().ok())
        .unwrap_or_else(|| root.join(BUILD_DIR))
        .join("runtime-bin");
    fs::create_dir_all(&bin_dir)?;

    if let Some((python, latexminted)) = compatible_latexminted_runtime() {
        let python_shim = bin_dir.join("python3");
        fs::write(
            &python_shim,
            format!("#!/bin/sh\nexec \"{}\" \"$@\"\n", python.display()),
        )?;
        let mut permissions = fs::metadata(&python_shim)?.permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&python_shim, permissions)?;

        // TeX Live invokes latexminted through restricted shell escape.  Its
        // upstream /usr/bin/env python3 shebang can otherwise select a newer,
        // incompatible system Python before our project is processed.  Keep
        // the trusted executable name but pin both interpreter and script.
        let latexminted_shim = bin_dir.join("latexminted");
        fs::write(
            &latexminted_shim,
            format!(
                "#!/bin/sh\nexec \"{}\" \"{}\" \"$@\"\n",
                python.display(),
                latexminted.display()
            ),
        )?;
        let mut permissions = fs::metadata(&latexminted_shim)?.permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&latexminted_shim, permissions)?;
    }

    install_compatible_biber(&bin_dir)?;

    let mut paths = vec![bin_dir];
    if let Some(existing) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&existing));
    }
    let path = std::env::join_paths(paths)
        .map_err(|error| AppError::Message(format!("PATH inválido: {error}")))?;
    command.env("PATH", path);
    Ok(())
}

#[cfg(not(unix))]
fn configure_runtime_compatibility(
    _command: &mut Command,
    _root: &Path,
    _app: Option<&tauri::AppHandle>,
) -> Result<(), AppError> {
    Ok(())
}

#[cfg(target_os = "macos")]
fn install_compatible_biber(bin_dir: &Path) -> Result<(), AppError> {
    use std::os::unix::fs::PermissionsExt;

    let destination = bin_dir.join("biber");
    if fs::metadata(&destination)
        .map(|metadata| metadata.len() > 0)
        .unwrap_or(false)
    {
        return Ok(());
    }
    let Some(source) = find_executable("biber") else {
        return Ok(());
    };
    let architecture = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x86_64",
        _ => return Ok(()),
    };
    let pending = bin_dir.join("biber.pending");
    let _ = fs::remove_file(&pending);
    let result = std::process::Command::new("/usr/bin/lipo")
        .args(["-thin", architecture])
        .arg(source)
        .arg("-output")
        .arg(&pending)
        .status();
    if result.map(|status| status.success()).unwrap_or(false) {
        let mut permissions = fs::metadata(&pending)?.permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&pending, permissions)?;
        fs::rename(pending, destination)?;
    } else {
        let _ = fs::remove_file(pending);
    }
    Ok(())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn install_compatible_biber(_bin_dir: &Path) -> Result<(), AppError> {
    Ok(())
}

async fn stream_build_output<R>(
    reader: R,
    app: Option<tauri::AppHandle>,
    stream: &'static str,
) -> Result<String, AppError>
where
    R: AsyncRead + Unpin,
{
    let mut reader = reader;
    let mut bytes = [0_u8; 8192];
    let mut output = String::new();
    loop {
        let read = reader.read(&mut bytes).await?;
        if read == 0 {
            break;
        }
        let data = String::from_utf8_lossy(&bytes[..read]).into_owned();
        output.push_str(&data);
        if let Some(app) = &app {
            let _ = app.emit("build-log", BuildLogChunk { data, stream });
        }
    }
    Ok(output)
}

async fn run_build_command(
    mut command: Command,
    app: Option<tauri::AppHandle>,
) -> Result<(ExitStatus, String), AppError> {
    command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command.spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Message("No se pudo leer stdout".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::Message("No se pudo leer stderr".into()))?;
    let stdout_task = tokio::spawn(stream_build_output(stdout, app.clone(), "stdout"));
    let stderr_task = tokio::spawn(stream_build_output(stderr, app, "stderr"));

    let process = async move {
        let status = child.wait().await?;
        let mut log = stdout_task
            .await
            .map_err(|error| AppError::Message(error.to_string()))??;
        let stderr = stderr_task
            .await
            .map_err(|error| AppError::Message(error.to_string()))??;
        if !stderr.trim().is_empty() {
            log.push('\n');
            log.push_str(&stderr);
        }
        Ok::<_, AppError>((status, log))
    };
    timeout(Duration::from_secs(180), process)
        .await
        .map_err(|_| AppError::Timeout)?
}

fn extract_diagnostics(log: &str) -> Vec<Diagnostic> {
    log.lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            let lower = trimmed.to_lowercase();
            if trimmed.starts_with('!') || lower.contains("error:") {
                Some(Diagnostic {
                    severity: "error",
                    message: trimmed.to_string(),
                })
            } else if lower.contains("warning") || lower.starts_with("overfull") {
                Some(Diagnostic {
                    severity: "warning",
                    message: trimmed.to_string(),
                })
            } else {
                None
            }
        })
        .take(100)
        .collect()
}

#[tauri::command]
async fn compile_project(
    app: tauri::AppHandle,
    request: BuildRequest,
) -> Result<BuildResult, AppError> {
    compile_project_inner(Some(app), request).await
}

async fn compile_project_inner(
    app: Option<tauri::AppHandle>,
    request: BuildRequest,
) -> Result<BuildResult, AppError> {
    let started = Instant::now();
    let root = canonical_root(&request.project_root)?;
    let document_path = project_path(&root, &request.document)?;
    let output_dir = project_build_dir(&root, app.as_ref())?;
    if app.is_some() {
        remove_cache_path(&root.join(BUILD_DIR))?;
        remove_cache_path(&root.join("svg-inkscape"))?;
    }
    fs::create_dir_all(&output_dir)?;
    fs::create_dir_all(output_dir.join("svg-inkscape"))?;
    let pdf_name = document_path
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| AppError::Message("Nombre de documento inválido".into()))?
        .to_string()
        + ".pdf";
    let pdf_path = output_dir.join(pdf_name);
    let fingerprint_path = output_dir.join(".fingerprint");
    let dependency_path = output_dir.join(".dependencies.json");
    let fingerprint = project_fingerprint(&root, &request, &dependency_path)?;
    if pdf_path.is_file()
        && fs::read_to_string(&fingerprint_path)
            .map(|saved| saved == fingerprint)
            .unwrap_or(false)
    {
        return Ok(BuildResult {
            success: true,
            cached: true,
            duration_ms: started.elapsed().as_millis(),
            pdf_path: Some(pdf_path.to_string_lossy().into_owned()),
            log: "Resultado recuperado de la caché de compilación.".into(),
            diagnostics: Vec::new(),
        });
    }

    // Never mistake a PDF from an older build for an artifact produced by the
    // current command. TeX may still create a usable PDF before returning a
    // non-zero status because of a later auxiliary-tool error.
    if pdf_path.is_file() {
        fs::remove_file(&pdf_path)?;
    }

    let (program, args) = build_command(&request, &output_dir, &document_path)?;
    let mut command = Command::new(program);
    command.args(args).current_dir(&root);
    configure_runtime_compatibility(&mut command, &root, app.as_ref())?;
    let (status, log) = run_build_command(command, app).await?;
    let pdf_generated = pdf_path.is_file();
    let success = status.success() && pdf_generated;
    if success {
        let fls_name = document_path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("main")
            .to_string()
            + ".fls";
        save_dependencies(&root, &output_dir.join(fls_name), &dependency_path)?;
        let final_fingerprint = project_fingerprint(&root, &request, &dependency_path)?;
        fs::write(fingerprint_path, final_fingerprint)?;
    }
    let diagnostics = extract_diagnostics(&log);
    Ok(BuildResult {
        success,
        cached: false,
        duration_ms: started.elapsed().as_millis(),
        pdf_path: pdf_generated.then(|| pdf_path.to_string_lossy().into_owned()),
        log,
        diagnostics,
    })
}

fn clear_build_cache_inner(
    app: Option<&tauri::AppHandle>,
    project_root: String,
) -> Result<(), AppError> {
    let root = canonical_root(&project_root)?;
    let cache = project_build_dir(&root, app)?;
    remove_cache_path(&cache)?;
    if app.is_some() {
        remove_cache_path(&root.join(BUILD_DIR))?;
    }
    fs::create_dir_all(cache.join("svg-inkscape"))?;
    Ok(())
}

#[tauri::command]
fn clear_build_cache(app: tauri::AppHandle, project_root: String) -> Result<(), AppError> {
    clear_build_cache_inner(Some(&app), project_root)
}

#[tauri::command]
fn export_pdf(source: String, destination: String) -> Result<(), AppError> {
    let source = fs::canonicalize(source)?;
    if source.extension().and_then(|ext| ext.to_str()) != Some("pdf") {
        return Err(AppError::InvalidPath(source.to_string_lossy().into_owned()));
    }
    fs::copy(source, destination)?;
    Ok(())
}

#[tauri::command]
fn read_build_pdf(
    app: tauri::AppHandle,
    project_root: String,
    path: String,
) -> Result<tauri::ipc::Response, AppError> {
    let root = canonical_root(&project_root)?;
    let build_root = fs::canonicalize(project_build_dir(&root, Some(&app))?)?;
    let source = fs::canonicalize(&path)?;
    if !source.starts_with(build_root)
        || source.extension().and_then(|extension| extension.to_str()) != Some("pdf")
        || !source.is_file()
    {
        return Err(AppError::InvalidPath(path));
    }
    Ok(tauri::ipc::Response::new(fs::read(source)?))
}

fn parse_synctex_location(output: &str) -> Option<(&str, usize, usize)> {
    let mut input = None;
    let mut line: Option<usize> = None;
    let mut column: usize = 0;
    for value in output.lines().map(str::trim) {
        if let Some(value) = value.strip_prefix("Input:") {
            input = Some(value.trim());
        } else if let Some(value) = value.strip_prefix("Line:") {
            line = value.trim().parse().ok();
        } else if let Some(value) = value.strip_prefix("Column:") {
            column = value.trim().parse::<isize>().unwrap_or(-1).max(0) as usize;
        }
    }
    Some((input?, line?.max(1), column))
}

async fn inverse_search_inner(
    app: Option<&tauri::AppHandle>,
    project_root: String,
    pdf_path: String,
    page: u32,
    x: f64,
    y: f64,
) -> Result<SourceLocation, AppError> {
    if page == 0 || !x.is_finite() || !y.is_finite() || x < 0.0 || y < 0.0 {
        return Err(AppError::Message("Posición del PDF inválida".into()));
    }
    let root = canonical_root(&project_root)?;
    let build_root = fs::canonicalize(project_build_dir(&root, app)?)?;
    let pdf = fs::canonicalize(pdf_path)?;
    if !pdf.starts_with(&build_root)
        || pdf.extension().and_then(|extension| extension.to_str()) != Some("pdf")
        || !pdf.is_file()
    {
        return Err(AppError::InvalidPath(pdf.to_string_lossy().into_owned()));
    }
    let synctex = find_executable("synctex")
        .ok_or_else(|| AppError::EngineUnavailable("synctex".into()))?;
    let query = format!("{page}:{x:.3}:{y:.3}:{}", pdf.display());
    let output = Command::new(synctex)
        .args(["edit", "-o", &query])
        .current_dir(&root)
        .output()
        .await?;
    if !output.status.success() {
        return Err(AppError::Message(
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let (input, line, column) = parse_synctex_location(&stdout).ok_or_else(|| {
        AppError::Message("No hay una posición de código asociada a ese punto del PDF".into())
    })?;
    let input_path = Path::new(input);
    let source = fs::canonicalize(if input_path.is_absolute() {
        input_path.to_path_buf()
    } else {
        root.join(input_path)
    })?;
    if !source.starts_with(&root) || !source.is_file() {
        return Err(AppError::InvalidPath(input.to_string()));
    }
    let relative = source
        .strip_prefix(&root)
        .map_err(|_| AppError::InvalidPath(input.to_string()))?
        .to_string_lossy()
        .replace('\\', "/");
    Ok(SourceLocation {
        path: relative,
        line,
        column,
    })
}

#[tauri::command]
async fn inverse_search(
    app: tauri::AppHandle,
    project_root: String,
    pdf_path: String,
    page: u32,
    x: f64,
    y: f64,
) -> Result<SourceLocation, AppError> {
    inverse_search_inner(Some(&app), project_root, pdf_path, page, x, y).await
}

#[tauri::command]
fn export_sources(project_root: String, destination: String) -> Result<(), AppError> {
    let root = canonical_root(&project_root)?;
    let file = fs::File::create(destination)?;
    let mut archive = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    let walker = WalkBuilder::new(&root)
        .hidden(false)
        .git_ignore(false)
        .git_exclude(false)
        .filter_entry(ignored_entry)
        .build();
    for entry in walker.filter_map(Result::ok).skip(1) {
        let path = entry.path();
        let relative = path
            .strip_prefix(&root)
            .map_err(|_| AppError::InvalidPath(path.to_string_lossy().into_owned()))?;
        let name = relative.to_string_lossy().replace('\\', "/");
        if path.is_dir() {
            archive.add_directory(name, options)?;
        } else {
            archive.start_file(name, options)?;
            let mut input = fs::File::open(path)?;
            std::io::copy(&mut input, &mut archive)?;
        }
    }
    archive.finish()?;
    Ok(())
}

#[tauri::command]
async fn git_action(project_root: String, action: String) -> Result<GitResult, AppError> {
    let root = canonical_root(&project_root)?;
    let args: &[&str] = match action.as_str() {
        "status" => &["status", "--short", "--branch"],
        "pull" => &["pull", "--ff-only"],
        "push" => &["push"],
        "fetch" => &["fetch", "--prune"],
        _ => return Err(AppError::Message("Acción Git no permitida".into())),
    };
    let output = Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .await?;
    let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&output.stderr));
    Ok(GitResult {
        success: output.status.success(),
        output: text,
    })
}

#[tauri::command]
fn start_terminal(
    app: tauri::AppHandle,
    state: tauri::State<'_, TerminalState>,
    project_root: String,
) -> Result<u32, AppError> {
    let root = canonical_root(&project_root)?;
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 24,
            cols: 100,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| AppError::Message(error.to_string()))?;
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut command = CommandBuilder::new(shell);
    command.cwd(root);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| AppError::Message(error.to_string()))?;
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| AppError::Message(error.to_string()))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| AppError::Message(error.to_string()))?;
    let id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let writer = Arc::new(Mutex::new(writer));
    let master = Arc::new(Mutex::new(pair.master));
    state
        .sessions
        .lock()
        .map_err(|_| AppError::Message("No se pudo bloquear la terminal".into()))?
        .insert(
            id,
            TerminalSession {
                writer,
                master,
                child,
            },
        );

    std::thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(size) => {
                    let data = String::from_utf8_lossy(&buffer[..size]).into_owned();
                    let _ = app.emit("terminal-output", TerminalOutput { id, data });
                }
            }
        }
    });
    Ok(id)
}

#[tauri::command]
fn write_terminal(
    state: tauri::State<'_, TerminalState>,
    id: u32,
    data: String,
) -> Result<(), AppError> {
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| AppError::Message("No se pudo bloquear la terminal".into()))?;
    let session = sessions
        .get(&id)
        .ok_or_else(|| AppError::Message("La terminal ya no está disponible".into()))?;
    let mut writer = session
        .writer
        .lock()
        .map_err(|_| AppError::Message("No se pudo escribir en la terminal".into()))?;
    writer.write_all(data.as_bytes())?;
    writer.flush()?;
    Ok(())
}

#[tauri::command]
fn resize_terminal(
    state: tauri::State<'_, TerminalState>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), AppError> {
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| AppError::Message("No se pudo bloquear la terminal".into()))?;
    let session = sessions
        .get(&id)
        .ok_or_else(|| AppError::Message("La terminal ya no está disponible".into()))?;
    session
        .master
        .lock()
        .map_err(|_| AppError::Message("No se pudo redimensionar la terminal".into()))?
        .resize(PtySize {
            rows: rows.max(2),
            cols: cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| AppError::Message(error.to_string()))
}

#[tauri::command]
fn stop_terminal(state: tauri::State<'_, TerminalState>, id: u32) -> Result<(), AppError> {
    if let Some(mut session) = state
        .sessions
        .lock()
        .map_err(|_| AppError::Message("No se pudo bloquear la terminal".into()))?
        .remove(&id)
    {
        session
            .child
            .kill()
            .map_err(|error| AppError::Message(error.to_string()))?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(TerminalState::default())
        .setup(|app| {
            if cfg!(debug_assertions)
                && let Some(window) = app.get_webview_window("main")
            {
                window.set_title("Latex Workbench · desarrollo")?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_engines,
            discover_project,
            read_project_file,
            read_project_asset,
            import_project_image,
            default_download_path,
            write_project_file,
            clear_build_cache,
            compile_project,
            read_build_pdf,
            inverse_search,
            export_pdf,
            export_sources,
            git_action,
            start_terminal,
            write_terminal,
            resize_terminal,
            stop_terminal
        ])
        .run(tauri::generate_context!())
        .expect("error al iniciar Latex Workbench");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostics_separate_errors_and_warnings() {
        let diagnostics = extract_diagnostics(
            "LaTeX Warning: Reference undefined\n! Undefined control sequence.\nOutput written",
        );
        assert_eq!(diagnostics.len(), 2);
        assert_eq!(diagnostics[0].severity, "warning");
        assert_eq!(diagnostics[1].severity, "error");
    }

    #[test]
    fn synctex_output_extracts_source_location() {
        let output = "SyncTeX result begin\nInput:/tmp/project/chapter.tex\nLine:42\nColumn:-1\nSyncTeX result end";
        assert_eq!(
            parse_synctex_location(output),
            Some(("/tmp/project/chapter.tex", 42, 0))
        );
    }

    #[tokio::test]
    async fn inverse_search_resolves_a_compiled_pdf_position() {
        if find_executable("lualatex").is_none() || find_executable("synctex").is_none() {
            return;
        }
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("workspace root")
            .join("tests/fixtures/inverse");
        let request = BuildRequest {
            project_root: root.to_string_lossy().into_owned(),
            document: "main.tex".into(),
            engine: "lualatex".into(),
            shell_escape: false,
        };
        let result = compile_project_inner(None, request)
            .await
            .expect("build for inverse search");
        let location = inverse_search_inner(
            None,
            root.to_string_lossy().into_owned(),
            result.pdf_path.expect("compiled pdf"),
            1,
            100.0,
            100.0,
        )
        .await
        .expect("inverse search result");
        assert_eq!(location.path, "main.tex");
        assert!(location.line > 0);
    }

    #[test]
    fn executable_lookup_finds_installed_tex() {
        assert!(find_executable("latexmk").is_some());
    }

    #[test]
    fn complete_build_uses_incremental_latexmk() {
        if find_executable("lualatex").is_none() || find_executable("latexmk").is_none() {
            return;
        }
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("workspace root")
            .join("tests/fixtures/basic");
        let document = root.join("main.tex");
        let output = root.join(BUILD_DIR).join("build");
        let request = BuildRequest {
            project_root: root.to_string_lossy().into_owned(),
            document: "main.tex".into(),
            engine: "lualatex".into(),
            shell_escape: false,
        };
        let (program, _) = build_command(&request, &output, &document).expect("build");
        assert_eq!(program.file_name().and_then(|name| name.to_str()), Some("latexmk"));
    }

    #[test]
    #[cfg(unix)]
    fn latexminted_runtime_uses_a_compatible_python() {
        let Some((python, latexminted)) = compatible_latexminted_runtime() else {
            return;
        };
        let output = std::process::Command::new(python)
            .arg(latexminted)
            .arg("--version")
            .output()
            .expect("latexminted version check");
        assert!(output.status.success());
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn minted_compiles_with_restricted_shell_escape() {
        if find_executable("lualatex").is_none() || compatible_latexminted_runtime().is_none() {
            return;
        }
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("workspace root")
            .join("tests/fixtures/minted");
        let request = BuildRequest {
            project_root: root.to_string_lossy().into_owned(),
            document: "main.tex".into(),
            engine: "lualatex".into(),
            shell_escape: false,
        };
        clear_build_cache_inner(None, request.project_root.clone())
            .expect("clear minted fixture cache");
        let result = compile_project_inner(None, request)
            .await
            .expect("minted build");
        assert!(result.success, "{}", result.log);
    }

    #[tokio::test]
    async fn build_resolves_autoref_and_apa_bibliography() {
        if find_executable("lualatex").is_none()
            || find_executable("latexmk").is_none()
            || find_executable("biber").is_none()
        {
            return;
        }
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("workspace root")
            .join("tests/fixtures/references");
        let request = BuildRequest {
            project_root: root.to_string_lossy().into_owned(),
            document: "main.tex".into(),
            engine: "lualatex".into(),
            shell_escape: false,
        };
        clear_build_cache_inner(None, request.project_root.clone())
            .expect("clear references fixture cache");
        let result = compile_project_inner(None, request)
            .await
            .expect("references build");
        assert!(result.success, "{}", result.log);

        let output = root.join(BUILD_DIR).join("build");
        let bbl = fs::read_to_string(output.join("main.bbl")).expect("Biber output");
        assert!(bbl.contains("Gamma"));
        let aux = fs::read_to_string(output.join("main.aux")).expect("LaTeX aux output");
        assert!(aux.contains("newlabel{sec:patterns}"));

        if let Some(pdftotext) = find_executable("pdftotext") {
            let text = std::process::Command::new(pdftotext)
                .arg(result.pdf_path.expect("compiled references pdf"))
                .arg("-")
                .output()
                .expect("extract references PDF text");
            assert!(text.status.success());
            let text = String::from_utf8_lossy(&text.stdout);
            assert!(!text.contains("??"), "{text}");
            assert!(text.contains("Gamma"), "{text}");
            assert!(text.contains("section 1"), "{text}");
        }
    }

    #[tokio::test]
    async fn svg_artifacts_stay_inside_the_private_build_directory() {
        if find_executable("lualatex").is_none()
            || find_executable("latexmk").is_none()
            || find_executable("inkscape").is_none()
        {
            return;
        }
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("workspace root")
            .join("tests/fixtures/svg");
        clear_build_cache_inner(None, root.to_string_lossy().into_owned())
            .expect("clear SVG fixture cache");
        let request = BuildRequest {
            project_root: root.to_string_lossy().into_owned(),
            document: "main.tex".into(),
            engine: "lualatex".into(),
            shell_escape: true,
        };
        let result = compile_project_inner(None, request)
            .await
            .expect("SVG build");
        assert!(result.success, "{}", result.log);
        assert!(!root.join("svg-inkscape").exists());
        let generated = root.join(BUILD_DIR).join("build").join("svg-inkscape");
        assert!(generated.is_dir());
        assert!(fs::read_dir(generated).expect("SVG artifacts").next().is_some());
    }

    #[tokio::test]
    async fn a_second_identical_build_uses_the_cache() {
        if find_executable("lualatex").is_none() {
            return;
        }
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("workspace root")
            .join("tests/fixtures/basic");
        let request = || BuildRequest {
            project_root: root.to_string_lossy().into_owned(),
            document: "main.tex".into(),
            engine: "lualatex".into(),
            shell_escape: false,
        };
        let first = compile_project_inner(None, request())
            .await
            .expect("first build");
        assert!(first.success);
        let second = compile_project_inner(None, request())
            .await
            .expect("cached build");
        assert!(second.success);
        assert!(second.cached);
    }
}
