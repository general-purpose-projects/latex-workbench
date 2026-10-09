use blake3::Hasher;
use ignore::{DirEntry, WalkBuilder};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::Stdio,
    time::{Duration, Instant},
};
use tauri::Manager;
use tokio::{process::Command, time::timeout};
use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

const BUILD_DIR: &str = ".latex-workbench";
const MAX_PROJECT_FILES: usize = 10_000;

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
    profile: String,
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
    hasher.update(request.document.as_bytes());
    hasher.update(request.engine.as_bytes());
    hasher.update(request.profile.as_bytes());
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
        ];
        if request.shell_escape {
            args.push("-shell-escape".into());
        }
        args.push(document);
        return Ok((engine_path, args));
    }

    if request.profile == "release" {
        let latexmk = find_executable("latexmk")
            .ok_or_else(|| AppError::EngineUnavailable("latexmk".into()))?;
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
async fn compile_project(request: BuildRequest) -> Result<BuildResult, AppError> {
    let started = Instant::now();
    let root = canonical_root(&request.project_root)?;
    let document_path = project_path(&root, &request.document)?;
    let profile = if request.profile == "release" {
        "release"
    } else {
        "preview"
    };
    let output_dir = root.join(BUILD_DIR).join(profile);
    fs::create_dir_all(&output_dir)?;
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

    let (program, args) = build_command(&request, &output_dir, &document_path)?;
    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(&root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let output = timeout(Duration::from_secs(180), command.output())
        .await
        .map_err(|_| AppError::Timeout)??;
    let mut log = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !stderr.trim().is_empty() {
        log.push('\n');
        log.push_str(&stderr);
    }
    let success = output.status.success() && pdf_path.is_file();
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
        pdf_path: success.then(|| pdf_path.to_string_lossy().into_owned()),
        log,
        diagnostics,
    })
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
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
            write_project_file,
            compile_project,
            export_pdf,
            export_sources,
            git_action
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
    fn executable_lookup_finds_installed_tex() {
        assert!(find_executable("latexmk").is_some());
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
            profile: "preview".into(),
            shell_escape: false,
        };
        let first = compile_project(request()).await.expect("first build");
        assert!(first.success);
        let second = compile_project(request()).await.expect("cached build");
        assert!(second.success);
        assert!(second.cached);
    }
}
