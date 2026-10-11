use blake3::Hasher;
use ignore::{DirEntry, WalkBuilder};
use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
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
const MAX_BUILD_LOG_BYTES: usize = 2 * 1024 * 1024;
const MAX_CACHE_METADATA_BYTES: u64 = 4 * 1024 * 1024;
const BUILD_LOG_TRUNCATED: &str = "\n[Registro truncado: límite de 2 MiB]\n";
const BUILD_PIPELINE_VERSION: &[u8] = b"4-sandboxed-profile-build";
const PROJECT_CONFIG_FILE: &str = ".latex-workbench.json";
static PROJECT_CONFIG_TEMP_ID: AtomicU32 = AtomicU32::new(0);

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum BuildProfile {
    #[default]
    Preview,
    Release,
}

impl BuildProfile {
    fn directory(self) -> &'static str {
        match self {
            Self::Preview => "preview",
            Self::Release => "release",
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectConfig {
    version: u32,
    main_document: Option<String>,
    engine: Option<String>,
    #[serde(default)]
    profile: BuildProfile,
}

impl Default for ProjectConfig {
    fn default() -> Self {
        Self {
            version: 1,
            main_document: None,
            engine: None,
            profile: BuildProfile::Preview,
        }
    }
}

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
    warnings: Vec<String>,
    truncated: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BuildRequest {
    project_root: String,
    document: String,
    engine: String,
    shell_escape: bool,
    #[serde(default)]
    profile: BuildProfile,
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EnvironmentCheck {
    id: &'static str,
    label: &'static str,
    available: bool,
    required: bool,
    instructions: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EnvironmentReport {
    engines: Vec<EngineInfo>,
    checks: Vec<EnvironmentCheck>,
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

fn append_bounded_output(output: &mut String, data: &str) {
    let payload_limit = MAX_BUILD_LOG_BYTES - BUILD_LOG_TRUNCATED.len();
    if output.len() >= payload_limit {
        if !output.ends_with(BUILD_LOG_TRUNCATED) {
            output.push_str(BUILD_LOG_TRUNCATED);
        }
        return;
    }
    let remaining = payload_limit - output.len();
    let mut end = data.len().min(remaining);
    while !data.is_char_boundary(end) {
        end -= 1;
    }
    output.push_str(&data[..end]);
    if end < data.len() {
        output.push_str(BUILD_LOG_TRUNCATED);
    }
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

fn project_directory(root: &Path, relative: &str) -> Result<PathBuf, AppError> {
    if relative.is_empty() {
        return Ok(root.to_path_buf());
    }
    let candidate = fs::canonicalize(root.join(relative))?;
    if !candidate.starts_with(root) || !candidate.is_dir() {
        return Err(AppError::InvalidPath(relative.to_string()));
    }
    Ok(candidate)
}

fn safe_entry_name(name: &str) -> Result<&str, AppError> {
    let path = Path::new(name);
    if name.trim().is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || name.contains('\0')
        || path.file_name().and_then(|value| value.to_str()) != Some(name)
    {
        return Err(AppError::InvalidPath(name.to_string()));
    }
    Ok(name)
}

fn executable_candidates(name: &str) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&path) {
            if !directory.is_absolute() {
                continue;
            }
            candidates.push(directory.join(name));
            #[cfg(target_os = "windows")]
            candidates.push(directory.join(format!("{name}.exe")));
        }
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

fn project_build_dir(root: &Path, app: Option<&tauri::AppHandle>) -> Result<PathBuf, AppError> {
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

fn profile_build_dir(
    root: &Path,
    app: Option<&tauri::AppHandle>,
    profile: BuildProfile,
) -> Result<PathBuf, AppError> {
    Ok(project_build_dir(root, app)?.join(profile.directory()))
}

fn remove_cache_path(path: &Path) -> Result<(), AppError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
            fs::remove_dir_all(path)?;
        }
        Ok(_) => fs::remove_file(path)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(AppError::Io(error)),
    }
    Ok(())
}

fn is_regular_file(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| metadata.file_type().is_file())
        .unwrap_or(false)
}

fn ensure_cache_directory(path: &Path, clear: bool) -> Result<(), AppError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
            if clear {
                fs::remove_dir_all(path)?;
                fs::create_dir(path)?;
            }
        }
        Ok(_) => {
            remove_cache_path(path)?;
            fs::create_dir_all(path)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(path)?;
        }
        Err(error) => return Err(AppError::Io(error)),
    }
    Ok(())
}

fn replace_cache_file(path: &Path, contents: &[u8]) -> Result<(), AppError> {
    let id = PROJECT_CONFIG_TEMP_ID.fetch_add(1, Ordering::Relaxed);
    let temporary = path.with_extension(format!("{id}.tmp"));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    file.write_all(contents)?;
    file.sync_all()?;
    drop(file);
    if cfg!(windows) && fs::symlink_metadata(path).is_ok() {
        remove_cache_path(path)?;
    }
    if let Err(error) = fs::rename(&temporary, path) {
        let _ = fs::remove_file(temporary);
        return Err(AppError::Io(error));
    }
    Ok(())
}

fn read_regular_file(path: &Path) -> Option<Vec<u8>> {
    if !is_regular_file(path) {
        return None;
    }
    let mut file = fs::File::open(path).ok()?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file() || metadata.len() > MAX_CACHE_METADATA_BYTES {
        return None;
    }
    let mut contents = Vec::new();
    Read::by_ref(&mut file)
        .take(MAX_CACHE_METADATA_BYTES + 1)
        .read_to_end(&mut contents)
        .ok()?;
    (contents.len() as u64 <= MAX_CACHE_METADATA_BYTES).then_some(contents)
}

#[tauri::command]
fn list_engines() -> Vec<EngineInfo> {
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
        engines.push(EngineInfo {
            id,
            label,
            available: path.is_some(),
            path: path.map(|path| path.to_string_lossy().into_owned()),
            version: None,
        });
    }
    engines
}

fn sandbox_runner() -> Option<PathBuf> {
    #[cfg(target_os = "linux")]
    {
        let runner = ["/usr/bin/bwrap", "/bin/bwrap"]
            .into_iter()
            .map(PathBuf::from)
            .find(|path| path.is_file())?;
        let true_binary = ["/usr/bin/true", "/bin/true"]
            .into_iter()
            .map(PathBuf::from)
            .find(|path| path.is_file())?;
        let status = std::process::Command::new(&runner)
            .env_clear()
            .args([
                "--die-with-parent",
                "--new-session",
                "--unshare-net",
                "--unshare-pid",
                "--unshare-ipc",
                "--unshare-uts",
                "--ro-bind",
                "/",
                "/",
                "--dev-bind",
                "/dev",
                "/dev",
                "--proc",
                "/proc",
                "--",
            ])
            .arg(true_binary)
            .status()
            .ok()?;
        status.success().then_some(runner)
    }
    #[cfg(target_os = "macos")]
    {
        let runner = PathBuf::from("/usr/bin/sandbox-exec");
        if !runner.is_file() {
            return None;
        }
        let status = std::process::Command::new(&runner)
            .env_clear()
            .args([
                "-p",
                "(version 1) (deny default) (allow process*) (allow file-read* (subpath \"/usr\") (subpath \"/System\") (subpath \"/dev\"))",
                "/usr/bin/true",
            ])
            .status()
            .ok()?;
        status.success().then_some(runner)
    }
    #[cfg(target_os = "windows")]
    {
        None
    }
}

#[tauri::command]
async fn diagnose_environment() -> EnvironmentReport {
    let engines = list_engines();
    let has_tex_engine = engines
        .iter()
        .any(|engine| engine.available && engine.id != "latexmk");
    let sandbox_available = sandbox_runner().is_some();
    let sandbox_instructions = if cfg!(target_os = "linux") {
        "Instala bubblewrap (bwrap), por ejemplo: sudo apt install bubblewrap."
    } else if cfg!(target_os = "macos") {
        "Se necesita sandbox-exec, incluido en macOS. Actualiza macOS si no está disponible."
    } else {
        "El aislamiento de compilación aún no está disponible en Windows; la compilación permanece bloqueada."
    };
    EnvironmentReport {
        engines,
        checks: vec![
            EnvironmentCheck {
                id: "tex",
                label: "Motor LaTeX",
                available: has_tex_engine,
                required: true,
                instructions: "Instala MacTeX, TeX Live o MiKTeX y asegúrate de que el motor esté en PATH.",
            },
            EnvironmentCheck {
                id: "sandbox",
                label: "Aislamiento de compilación",
                available: sandbox_available,
                required: true,
                instructions: sandbox_instructions,
            },
            EnvironmentCheck {
                id: "git",
                label: "Git (opcional)",
                available: find_executable("git").is_some(),
                required: false,
                instructions: "Instala Git para usar las acciones de control de versiones.",
            },
        ],
    }
}

fn valid_engine(engine: &str) -> bool {
    matches!(
        engine,
        "latexmk" | "lualatex" | "xelatex" | "pdflatex" | "tectonic"
    )
}

fn engine_download_url(engine: &str) -> Result<&'static str, AppError> {
    if engine == "tectonic" {
        return Ok("https://github.com/tectonic-typesetting/tectonic/releases/latest");
    }
    if !matches!(engine, "latexmk" | "lualatex" | "xelatex" | "pdflatex") {
        return Err(AppError::Message("Motor LaTeX no compatible".into()));
    }
    #[cfg(target_os = "windows")]
    {
        Ok("https://miktex.org/download")
    }
    #[cfg(target_os = "macos")]
    {
        Ok("https://www.tug.org/mactex/")
    }
    #[cfg(target_os = "linux")]
    {
        Ok("https://www.tug.org/texlive/acquire-netinstall.html")
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        Err(AppError::Message(
            "No hay una página de descarga configurada para este sistema".into(),
        ))
    }
}

#[tauri::command]
fn open_engine_download(engine: String) -> Result<(), AppError> {
    let url = engine_download_url(&engine)?;
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = std::process::Command::new("cmd.exe");
        command.args(["/C", "start", "", url]);
        command
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = std::process::Command::new("open");
        command.arg(url);
        command
    };
    #[cfg(target_os = "linux")]
    let mut command = {
        let mut command = std::process::Command::new("xdg-open");
        command.arg(url);
        command
    };
    command.spawn()?;
    Ok(())
}

#[tauri::command]
fn load_project_config(project_root: String) -> Result<ProjectConfig, AppError> {
    let root = canonical_root(&project_root)?;
    let path = root.join(PROJECT_CONFIG_FILE);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ProjectConfig::default());
        }
        Err(error) => return Err(AppError::Io(error)),
    };
    if !metadata.file_type().is_file() || metadata.len() > MAX_CACHE_METADATA_BYTES {
        return Err(AppError::InvalidPath(path.to_string_lossy().into_owned()));
    }
    let contents = read_regular_file(&path)
        .ok_or_else(|| AppError::InvalidPath(path.to_string_lossy().into_owned()))?;
    let config: ProjectConfig = serde_json::from_slice(&contents)?;
    if config.version != 1 {
        return Err(AppError::Message(format!(
            "Versión de configuración de proyecto no compatible: {}",
            config.version
        )));
    }
    if let Some(document) = &config.main_document {
        let source = project_path(&root, document)?;
        if source.extension().and_then(|extension| extension.to_str()) != Some("tex") {
            return Err(AppError::InvalidPath(document.clone()));
        }
    }
    if config
        .engine
        .as_deref()
        .is_some_and(|engine| !valid_engine(engine))
    {
        return Err(AppError::Message(
            "La configuración contiene un motor LaTeX no compatible".into(),
        ));
    }
    Ok(config)
}

#[tauri::command]
fn save_project_config(project_root: String, config: ProjectConfig) -> Result<(), AppError> {
    let root = canonical_root(&project_root)?;
    if config.version != 1 {
        return Err(AppError::Message(
            "Versión de configuración de proyecto no compatible".into(),
        ));
    }
    if let Some(document) = &config.main_document {
        let source = project_path(&root, document)?;
        if source.extension().and_then(|extension| extension.to_str()) != Some("tex") {
            return Err(AppError::InvalidPath(document.clone()));
        }
    }
    if config
        .engine
        .as_deref()
        .is_some_and(|engine| !valid_engine(engine))
    {
        return Err(AppError::Message(
            "El motor LaTeX seleccionado no es compatible".into(),
        ));
    }
    let destination = root.join(PROJECT_CONFIG_FILE);
    let temporary = root.join(format!(
        "{PROJECT_CONFIG_FILE}.{}.{}.tmp",
        std::process::id(),
        PROJECT_CONFIG_TEMP_ID.fetch_add(1, Ordering::Relaxed),
    ));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    file.write_all(&serde_json::to_vec_pretty(&config)?)?;
    file.sync_all()?;
    drop(file);
    if cfg!(windows) && destination.exists() {
        fs::remove_file(&destination)?;
    }
    if let Err(error) = fs::rename(&temporary, destination) {
        let _ = fs::remove_file(temporary);
        return Err(AppError::Io(error));
    }
    Ok(())
}

#[tauri::command]
fn discover_project(root: String) -> Result<ProjectInfo, AppError> {
    let root = canonical_root(&root)?;
    let mut files = Vec::new();
    let mut documents = Vec::new();
    let mut warnings = Vec::new();
    let mut truncated = false;
    let walker = WalkBuilder::new(&root)
        .hidden(false)
        .git_ignore(false)
        .git_exclude(false)
        .filter_entry(ignored_entry)
        .build();

    for result in walker.skip(1) {
        let result = match result {
            Ok(result) => result,
            Err(error) => {
                if warnings.len() < 5 {
                    warnings.push(error.to_string());
                }
                continue;
            }
        };
        if result
            .file_type()
            .is_some_and(|file_type| file_type.is_symlink())
        {
            continue;
        }
        if files.len() == MAX_PROJECT_FILES {
            truncated = true;
            break;
        }
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
        warnings,
        truncated,
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
        return Err(AppError::Message(
            "El formato de imagen no es compatible".into(),
        ));
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

#[tauri::command]
fn create_project_entry(
    project_root: String,
    directory: String,
    name: String,
    kind: String,
) -> Result<String, AppError> {
    let root = canonical_root(&project_root)?;
    let parent = project_directory(&root, &directory)?;
    let name = safe_entry_name(name.trim())?;
    let destination = parent.join(name);
    if destination.exists() {
        return Err(AppError::Message(format!("Ya existe “{name}”")));
    }
    match kind.as_str() {
        "file" => {
            fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&destination)?;
        }
        "directory" => fs::create_dir(&destination)?,
        _ => return Err(AppError::Message("Tipo de elemento inválido".into())),
    }
    destination
        .strip_prefix(&root)
        .map(|value| value.to_string_lossy().replace('\\', "/"))
        .map_err(|_| AppError::InvalidPath(destination.to_string_lossy().into_owned()))
}

#[tauri::command]
fn rename_project_entry(
    project_root: String,
    path: String,
    new_name: String,
) -> Result<String, AppError> {
    let root = canonical_root(&project_root)?;
    let source = fs::canonicalize(root.join(&path))?;
    if !source.starts_with(&root) || source == root {
        return Err(AppError::InvalidPath(path));
    }
    let name = safe_entry_name(new_name.trim())?;
    let destination = source
        .parent()
        .ok_or_else(|| AppError::InvalidPath(path.clone()))?
        .join(name);
    if destination.exists() {
        return Err(AppError::Message(format!("Ya existe “{name}”")));
    }
    fs::rename(&source, &destination)?;
    destination
        .strip_prefix(&root)
        .map(|value| value.to_string_lossy().replace('\\', "/"))
        .map_err(|_| AppError::InvalidPath(destination.to_string_lossy().into_owned()))
}

#[tauri::command]
fn remove_project_entry(project_root: String, path: String) -> Result<(), AppError> {
    let root = canonical_root(&project_root)?;
    let target = fs::canonicalize(root.join(&path))?;
    if !target.starts_with(&root) || target == root {
        return Err(AppError::InvalidPath(path));
    }
    if target.is_dir() {
        fs::remove_dir_all(target)?;
    } else {
        fs::remove_file(target)?;
    }
    Ok(())
}

fn import_destination(root: &Path, directory: &str, source: &Path) -> Result<PathBuf, AppError> {
    let parent = project_directory(root, directory)?;
    let name = source
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| AppError::InvalidPath(source.to_string_lossy().into_owned()))?;
    safe_entry_name(name)?;
    Ok(parent.join(name))
}

#[tauri::command]
fn project_import_conflicts(
    project_root: String,
    sources: Vec<String>,
    directory: String,
) -> Result<Vec<String>, AppError> {
    let root = canonical_root(&project_root)?;
    let mut conflicts = Vec::new();
    let mut destinations = HashSet::new();
    for source in sources {
        let source = fs::canonicalize(&source)?;
        if !source.is_file() {
            return Err(AppError::Message(format!(
                "Solo se pueden importar archivos: {}",
                source.display()
            )));
        }
        let destination = import_destination(&root, &directory, &source)?;
        let repeated_destination = !destinations.insert(destination.clone());
        if repeated_destination
            || (destination.exists()
                && fs::canonicalize(&destination).ok().as_ref() != Some(&source))
        {
            conflicts.push(
                destination
                    .strip_prefix(&root)
                    .unwrap_or(&destination)
                    .to_string_lossy()
                    .replace('\\', "/"),
            );
        }
    }
    Ok(conflicts)
}

#[tauri::command]
fn import_project_files(
    project_root: String,
    sources: Vec<String>,
    directory: String,
    overwrite: bool,
) -> Result<Vec<String>, AppError> {
    let root = canonical_root(&project_root)?;
    let mut imported = Vec::new();
    for source in sources {
        let source = fs::canonicalize(&source)?;
        if !source.is_file() {
            return Err(AppError::Message(format!(
                "Solo se pueden importar archivos: {}",
                source.display()
            )));
        }
        let destination = import_destination(&root, &directory, &source)?;
        if destination.exists() {
            if fs::canonicalize(&destination).ok().as_ref() == Some(&source) {
                continue;
            }
            if !overwrite {
                return Err(AppError::Message(format!(
                    "Ya existe “{}”",
                    destination
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                )));
            }
        }
        fs::copy(&source, &destination)?;
        imported.push(
            destination
                .strip_prefix(&root)
                .map_err(|_| AppError::InvalidPath(destination.to_string_lossy().into_owned()))?
                .to_string_lossy()
                .replace('\\', "/"),
        );
    }
    Ok(imported)
}

#[tauri::command]
fn export_project_file(
    project_root: String,
    path: String,
    destination: String,
) -> Result<(), AppError> {
    let root = canonical_root(&project_root)?;
    let source = project_path(&root, &path)?;
    fs::copy(source, destination)?;
    Ok(())
}

fn dependency_paths(root: &Path, dependency_file: &Path) -> Result<Vec<PathBuf>, AppError> {
    if let Some(contents) =
        read_regular_file(dependency_file).and_then(|bytes| String::from_utf8(bytes).ok())
        && let Ok(relative_paths) = serde_json::from_str::<Vec<String>>(&contents)
    {
        let paths: Vec<_> = relative_paths
            .into_iter()
            .filter_map(|relative| fs::canonicalize(root.join(relative)).ok())
            .filter(|path| path.starts_with(root) && is_regular_file(path))
            .collect();
        if !paths.is_empty() {
            return Ok(paths);
        }
    }

    let mut paths = Vec::new();
    for entry in WalkBuilder::new(root)
        .hidden(false)
        .git_ignore(false)
        .git_exclude(false)
        .filter_entry(ignored_entry)
        .build()
    {
        let path = entry
            .map_err(|error| {
                AppError::Message(format!("No se pudieron recorrer las fuentes: {error}"))
            })?
            .into_path();
        if is_regular_file(&path)
            && let Ok(canonical) = fs::canonicalize(path)
            && canonical.starts_with(root)
        {
            paths.push(canonical);
        }
    }
    Ok(paths)
}

fn project_fingerprint(
    root: &Path,
    request: &BuildRequest,
    dependency_file: &Path,
) -> Result<String, AppError> {
    let mut paths = dependency_paths(root, dependency_file)?;
    paths.sort();
    let mut hasher = Hasher::new();
    hasher.update(BUILD_PIPELINE_VERSION);
    hasher.update(request.document.as_bytes());
    hasher.update(request.engine.as_bytes());
    hasher.update(request.profile.directory().as_bytes());
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
            hasher.update(&fs::read(path)?);
        }
    }
    Ok(hasher.finalize().to_hex().to_string())
}

fn save_dependencies(root: &Path, fls_path: &Path, destination: &Path) -> Result<(), AppError> {
    let contents = read_regular_file(fls_path)
        .and_then(|contents| String::from_utf8(contents).ok())
        .unwrap_or_default();
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
    replace_cache_file(destination, &serde_json::to_vec_pretty(&dependencies)?)
}

fn build_command(
    request: &BuildRequest,
    output_dir: &Path,
    document_path: &Path,
) -> Result<(PathBuf, Vec<String>), AppError> {
    if request.profile == BuildProfile::Release && request.engine != "latexmk" {
        return Err(AppError::Message(
            "El perfil Release requiere Latexmk para garantizar una compilación completa.".into(),
        ));
    }
    let engine_path = find_executable(&request.engine)
        .ok_or_else(|| AppError::EngineUnavailable(request.engine.clone()))?;
    let output = output_dir.to_string_lossy().into_owned();
    let document = document_path.to_string_lossy().into_owned();
    let svg_output = output_dir
        .join("svg-inkscape")
        .to_string_lossy()
        .replace('\\', "/")
        + "/";
    let svg_pretex =
        format!("-usepretex=\\PassOptionsToPackage{{inkscapepath={{{svg_output}}}}}{{svg}}");

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
            "-norc".into(),
            format!("-outdir={output}"),
            svg_pretex.clone(),
        ];
        if request.profile == BuildProfile::Release {
            args.push("-gg".into());
        }
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
            "-norc".into(),
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

fn sandboxed_command(
    program: &Path,
    args: &[String],
    root: &Path,
    output_dir: &Path,
) -> Result<(PathBuf, Vec<String>), AppError> {
    let runner = sandbox_runner().ok_or_else(|| {
        if cfg!(target_os = "windows") {
            AppError::Message(
                "El aislamiento de compilación aún no está disponible en Windows; no se ejecutó el documento.".into(),
            )
        } else {
            AppError::Message(
                "No hay un sandbox de compilación disponible. Instálalo y vuelve a ejecutar el diagnóstico del entorno.".into(),
            )
        }
    })?;
    #[cfg(target_os = "linux")]
    {
        let mut sandbox_args = vec![
            "--die-with-parent".into(),
            "--new-session".into(),
            "--unshare-net".into(),
            "--unshare-pid".into(),
            "--unshare-ipc".into(),
            "--unshare-uts".into(),
            "--ro-bind".into(),
            "/".into(),
            "/".into(),
            "--dev-bind".into(),
            "/dev".into(),
            "/dev".into(),
            "--proc".into(),
            "/proc".into(),
            "--tmpfs".into(),
            "/tmp".into(),
            "--tmpfs".into(),
            "/home".into(),
            "--tmpfs".into(),
            "/root".into(),
        ];
        let mut created = HashSet::new();
        for path in [root, output_dir] {
            for masked_root in [Path::new("/home"), Path::new("/root"), Path::new("/tmp")] {
                if path.starts_with(masked_root)
                    && let Ok(relative) = path.strip_prefix(masked_root)
                {
                    let mut current = masked_root.to_path_buf();
                    for component in relative.components() {
                        let std::path::Component::Normal(component) = component else {
                            continue;
                        };
                        current.push(component);
                        if created.insert(current.clone()) {
                            sandbox_args.push("--dir".into());
                            sandbox_args.push(current.to_string_lossy().into_owned());
                        }
                    }
                    break;
                }
            }
        }
        sandbox_args.extend([
            "--ro-bind".into(),
            root.to_string_lossy().into_owned(),
            root.to_string_lossy().into_owned(),
            "--bind".into(),
            output_dir.to_string_lossy().into_owned(),
            output_dir.to_string_lossy().into_owned(),
            "--chdir".into(),
            root.to_string_lossy().into_owned(),
            "--".into(),
            program.to_string_lossy().into_owned(),
        ]);
        sandbox_args.extend_from_slice(args);
        Ok((runner, sandbox_args))
    }
    #[cfg(target_os = "macos")]
    {
        let project_path = root
            .to_string_lossy()
            .replace('\\', "\\\\")
            .replace('"', "\\\"");
        let output_path = output_dir
            .to_string_lossy()
            .replace('\\', "\\\\")
            .replace('"', "\\\"");
        let profile = format!(
            "(version 1) (deny default) (allow process*) (allow file-read* (subpath \"{project_path}\") (subpath \"{output_path}\") (subpath \"/usr\") (subpath \"/System\") (subpath \"/Library/TeX\") (subpath \"/Library/Developer\") (subpath \"/Library/Fonts\") (subpath \"/opt\") (subpath \"/bin\") (subpath \"/sbin\") (subpath \"/etc\") (subpath \"/private/etc\") (subpath \"/tmp\") (subpath \"/private/tmp\")) (allow file-read-metadata) (allow sysctl-read) (allow mach-lookup) (allow file-write* (subpath \"{output_path}\") (subpath \"/tmp\") (subpath \"/private/tmp\")) (deny network*)"
        );
        let mut sandbox_args = vec!["-p".into(), profile, program.to_string_lossy().into_owned()];
        sandbox_args.extend_from_slice(args);
        Ok((runner, sandbox_args))
    }
    #[cfg(target_os = "windows")]
    {
        let _ = (runner, program, args, root, output_dir);
        Err(AppError::Message(
            "El aislamiento de compilación aún no está disponible en Windows; no se ejecutó el documento.".into(),
        ))
    }
}

#[cfg(unix)]
fn compatible_latexminted_runtime() -> Option<(PathBuf, PathBuf)> {
    let latexminted = find_executable("latexminted")?;
    ["python3.13", "python3.12", "python3.11"]
        .into_iter()
        .find_map(find_executable)
        .map(|python| (python, latexminted))
}

#[cfg(unix)]
fn configure_runtime_compatibility(
    command: &mut Command,
    _root: &Path,
    output_dir: &Path,
) -> Result<(), AppError> {
    let bin_dir = output_dir.join("runtime-bin");
    ensure_cache_directory(&bin_dir, true)?;

    if let Some((python, latexminted)) = compatible_latexminted_runtime() {
        std::os::unix::fs::symlink(python, bin_dir.join("python3"))?;
        std::os::unix::fs::symlink(latexminted, bin_dir.join("latexminted"))?;
    }

    install_compatible_biber(&bin_dir)?;

    let mut paths = vec![bin_dir];
    if let Some(existing) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&existing));
    }
    let path = std::env::join_paths(paths)
        .map_err(|error| AppError::Message(format!("PATH inválido: {error}")))?;
    let home = output_dir.join("home");
    let temporary = output_dir.join("tmp");
    ensure_cache_directory(&home, false)?;
    ensure_cache_directory(&temporary, false)?;
    for directory in ["cache", "texmf-var", "texmf-config"] {
        ensure_cache_directory(&output_dir.join(directory), false)?;
    }
    command
        .env_clear()
        .env("PATH", path)
        .env("HOME", &home)
        .env("TMPDIR", &temporary)
        .env("TMP", &temporary)
        .env("TEMP", &temporary)
        .env("XDG_CACHE_HOME", output_dir.join("cache"))
        .env("TEXMFVAR", output_dir.join("texmf-var"))
        .env("TEXMFCONFIG", output_dir.join("texmf-config"));
    for variable in ["LANG", "LC_ALL"] {
        if let Some(value) = std::env::var_os(variable) {
            command.env(variable, value);
        }
    }
    Ok(())
}

#[cfg(not(unix))]
fn configure_runtime_compatibility(
    _command: &mut Command,
    _root: &Path,
    _output_dir: &Path,
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
    emitted_log: Arc<Mutex<String>>,
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
        append_bounded_output(&mut output, &data);
        if let Some(app) = &app {
            let emitted = {
                let mut aggregate = emitted_log
                    .lock()
                    .map_err(|_| AppError::Message("No se pudo limitar el registro".into()))?;
                let previous_length = aggregate.len();
                append_bounded_output(&mut aggregate, &data);
                aggregate[previous_length..].to_string()
            };
            if !emitted.is_empty() {
                let _ = app.emit(
                    "build-log",
                    BuildLogChunk {
                        data: emitted,
                        stream,
                    },
                );
            }
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
    let emitted_log = Arc::new(Mutex::new(String::new()));
    let stdout_task = tokio::spawn(stream_build_output(
        stdout,
        app.clone(),
        emitted_log.clone(),
        "stdout",
    ));
    let stderr_task = tokio::spawn(stream_build_output(stderr, app, emitted_log, "stderr"));

    let process = async move {
        let status = child.wait().await?;
        let mut log = stdout_task
            .await
            .map_err(|error| AppError::Message(error.to_string()))??;
        let stderr = stderr_task
            .await
            .map_err(|error| AppError::Message(error.to_string()))??;
        if !stderr.trim().is_empty() {
            append_bounded_output(&mut log, "\n");
            append_bounded_output(&mut log, &stderr);
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
    let output_dir = profile_build_dir(&root, app.as_ref(), request.profile)?;
    fs::create_dir_all(&output_dir)?;
    ensure_cache_directory(&output_dir, false)?;
    ensure_cache_directory(&output_dir.join("svg-inkscape"), false)?;
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
    if is_regular_file(&pdf_path)
        && read_regular_file(&fingerprint_path)
            .and_then(|bytes| String::from_utf8(bytes).ok())
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
    let (sandbox, sandbox_args) = sandboxed_command(&program, &args, &root, &output_dir)?;
    let mut command = Command::new(sandbox);
    command.args(sandbox_args).current_dir(&root);
    configure_runtime_compatibility(&mut command, &root, &output_dir)?;
    // Keep the last artifact until all preflight checks pass. Once the build is
    // about to run, remove it so a failed command cannot report it as current.
    remove_cache_path(&pdf_path)?;
    let (status, log) = run_build_command(command, app).await?;
    let pdf_generated = is_regular_file(&pdf_path);
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
        replace_cache_file(&fingerprint_path, final_fingerprint.as_bytes())?;
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
    fs::create_dir_all(cache)?;
    Ok(())
}

#[tauri::command]
fn clear_build_cache(app: tauri::AppHandle, project_root: String) -> Result<(), AppError> {
    clear_build_cache_inner(Some(&app), project_root)
}

#[tauri::command]
fn export_pdf(
    app: tauri::AppHandle,
    project_root: String,
    source: String,
    destination: String,
) -> Result<(), AppError> {
    let root = canonical_root(&project_root)?;
    let build_root = fs::canonicalize(project_build_dir(&root, Some(&app))?)?;
    let source_path = Path::new(&source);
    let source = fs::canonicalize(source_path)?;
    if !is_regular_file(source_path)
        || !source.starts_with(build_root)
        || source.extension().and_then(|ext| ext.to_str()) != Some("pdf")
    {
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
    let source_path = Path::new(&path);
    let source = fs::canonicalize(source_path)?;
    if !is_regular_file(source_path)
        || !source.starts_with(build_root)
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
    let pdf_path = Path::new(&pdf_path);
    let pdf = fs::canonicalize(pdf_path)?;
    if !is_regular_file(pdf_path)
        || !pdf.starts_with(&build_root)
        || pdf.extension().and_then(|extension| extension.to_str()) != Some("pdf")
        || !pdf.is_file()
    {
        return Err(AppError::InvalidPath(pdf.to_string_lossy().into_owned()));
    }
    let synctex =
        find_executable("synctex").ok_or_else(|| AppError::EngineUnavailable("synctex".into()))?;
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
    for entry in walker.skip(1) {
        let entry = entry.map_err(|error| {
            AppError::Message(format!(
                "No se pudieron exportar todas las fuentes: {error}"
            ))
        })?;
        let path = entry.path();
        if fs::symlink_metadata(path)?.file_type().is_symlink() {
            continue;
        }
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
    let shell = if cfg!(target_os = "windows") {
        std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".into())
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into())
    };
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
            diagnose_environment,
            open_engine_download,
            load_project_config,
            save_project_config,
            discover_project,
            read_project_file,
            read_project_asset,
            import_project_image,
            default_download_path,
            write_project_file,
            create_project_entry,
            rename_project_entry,
            remove_project_entry,
            project_import_conflicts,
            import_project_files,
            export_project_file,
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
    fn project_entry_names_cannot_escape_their_directory() {
        assert_eq!(safe_entry_name("capitulo.tex").unwrap(), "capitulo.tex");
        for invalid in [
            "",
            ".",
            "..",
            "../secreto.tex",
            "carpeta/archivo.tex",
            "carpeta\\archivo.tex",
        ] {
            assert!(safe_entry_name(invalid).is_err(), "accepted {invalid:?}");
        }
    }

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
    fn build_logs_are_bounded_without_splitting_utf8() {
        let mut output = String::new();
        append_bounded_output(&mut output, &"á🙂".repeat(600_000));

        assert!(output.len() <= MAX_BUILD_LOG_BYTES);
        assert!(output.ends_with(BUILD_LOG_TRUNCATED));
        assert!(!output.contains('\u{fffd}'));
        let bounded = output.clone();
        append_bounded_output(&mut output, "more output");
        assert_eq!(output, bounded);
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
        if sandbox_runner().is_none()
            || find_executable("lualatex").is_none()
            || find_executable("synctex").is_none()
        {
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
            profile: BuildProfile::Preview,
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
    fn supported_engine_list_is_explicit() {
        assert!(valid_engine("lualatex"));
        assert!(valid_engine("latexmk"));
        assert!(valid_engine("tectonic"));
        assert!(!valid_engine("sh"));
        assert!(
            engine_download_url("tectonic")
                .unwrap()
                .contains("releases/latest")
        );
        assert!(engine_download_url("sh").is_err());
    }

    #[test]
    fn project_configuration_round_trips_and_rejects_invalid_engines() {
        let root = std::env::temp_dir().join(format!(
            "latex-workbench-config-{}-{}",
            std::process::id(),
            PROJECT_CONFIG_TEMP_ID.fetch_add(1, Ordering::Relaxed),
        ));
        fs::create_dir_all(&root).expect("temporary project");
        fs::write(root.join("main.tex"), "\\documentclass{article}").expect("source file");
        let config = ProjectConfig {
            version: 1,
            main_document: Some("main.tex".into()),
            engine: Some("lualatex".into()),
            profile: BuildProfile::Release,
        };
        let project_root = root.to_string_lossy().into_owned();
        save_project_config(project_root.clone(), config.clone()).expect("save config");
        assert_eq!(
            load_project_config(project_root.clone()).expect("load config"),
            config
        );

        let invalid = ProjectConfig {
            engine: Some("sh".into()),
            ..config
        };
        assert!(save_project_config(project_root, invalid).is_err());
        fs::remove_dir_all(root).expect("remove temporary project");
    }

    #[test]
    fn release_profile_requires_latexmk() {
        let request = BuildRequest {
            project_root: "/tmp/project".into(),
            document: "main.tex".into(),
            engine: "lualatex".into(),
            shell_escape: false,
            profile: BuildProfile::Release,
        };
        assert!(
            build_command(
                &request,
                Path::new("/tmp/build"),
                Path::new("/tmp/project/main.tex")
            )
            .is_err()
        );
    }

    #[test]
    #[cfg(unix)]
    fn replacing_cache_metadata_does_not_follow_symlinks() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!(
            "latex-workbench-cache-{}-{}",
            std::process::id(),
            PROJECT_CONFIG_TEMP_ID.fetch_add(1, Ordering::Relaxed),
        ));
        fs::create_dir_all(&root).expect("temporary cache");
        let target = root.join("outside");
        let metadata = root.join(".fingerprint");
        fs::write(&target, b"unchanged").expect("external file");
        symlink(&target, &metadata).expect("metadata symlink");

        replace_cache_file(&metadata, b"safe metadata").expect("replace metadata");

        assert_eq!(
            fs::read(&target).expect("external file contents"),
            b"unchanged"
        );
        assert_eq!(
            fs::read(&metadata).expect("new metadata contents"),
            b"safe metadata"
        );
        fs::remove_dir_all(root).expect("remove temporary cache");
    }

    #[test]
    fn dependency_cache_rejects_paths_outside_the_project() {
        let root = std::env::temp_dir().join(format!(
            "latex-workbench-dependencies-{}-{}",
            std::process::id(),
            PROJECT_CONFIG_TEMP_ID.fetch_add(1, Ordering::Relaxed),
        ));
        fs::create_dir_all(&root).expect("temporary project");
        fs::write(root.join("main.tex"), "project source").expect("project source");
        let outside = root.parent().expect("temporary directory").join(format!(
            "latex-workbench-outside-{}",
            PROJECT_CONFIG_TEMP_ID.fetch_add(1, Ordering::Relaxed),
        ));
        fs::write(&outside, "private data").expect("outside file");
        let dependency_file = root.join("dependencies.json");
        fs::write(
            &dependency_file,
            serde_json::to_vec(&[format!(
                "../{}",
                outside.file_name().unwrap().to_string_lossy()
            )])
            .expect("dependency JSON"),
        )
        .expect("dependency cache");

        let paths = dependency_paths(&root, &dependency_file).expect("dependency paths");

        assert!(!paths.contains(&outside));
        fs::remove_file(outside).expect("remove outside file");
        fs::remove_dir_all(root).expect("remove temporary project");
    }

    #[test]
    fn complete_build_uses_incremental_latexmk() {
        if sandbox_runner().is_none()
            || find_executable("lualatex").is_none()
            || find_executable("latexmk").is_none()
        {
            return;
        }
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("workspace root")
            .join("tests/fixtures/basic");
        let document = root.join("main.tex");
        let output = profile_build_dir(&root, None, BuildProfile::Preview).expect("preview output");
        let request = BuildRequest {
            project_root: root.to_string_lossy().into_owned(),
            document: "main.tex".into(),
            engine: "lualatex".into(),
            shell_escape: false,
            profile: BuildProfile::Preview,
        };
        let (program, _) = build_command(&request, &output, &document).expect("build");
        assert_eq!(
            program.file_name().and_then(|name| name.to_str()),
            Some("latexmk")
        );
    }

    #[test]
    #[cfg(unix)]
    fn latexminted_runtime_selects_an_installed_python() {
        let Some((python, latexminted)) = compatible_latexminted_runtime() else {
            return;
        };
        assert!(python.is_file());
        assert!(latexminted.is_file());
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn minted_compiles_with_restricted_shell_escape() {
        if sandbox_runner().is_none()
            || find_executable("lualatex").is_none()
            || compatible_latexminted_runtime().is_none()
        {
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
            profile: BuildProfile::Preview,
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
        if sandbox_runner().is_none()
            || find_executable("lualatex").is_none()
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
            profile: BuildProfile::Preview,
        };
        clear_build_cache_inner(None, request.project_root.clone())
            .expect("clear references fixture cache");
        let result = compile_project_inner(None, request)
            .await
            .expect("references build");
        assert!(result.success, "{}", result.log);

        let output = profile_build_dir(&root, None, BuildProfile::Preview).expect("preview output");
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
        if sandbox_runner().is_none()
            || find_executable("lualatex").is_none()
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
            profile: BuildProfile::Preview,
        };
        let result = compile_project_inner(None, request)
            .await
            .expect("SVG build");
        assert!(result.success, "{}", result.log);
        assert!(!root.join("svg-inkscape").exists());
        let generated = profile_build_dir(&root, None, BuildProfile::Preview)
            .expect("preview output")
            .join("svg-inkscape");
        assert!(generated.is_dir());
        assert!(
            fs::read_dir(generated)
                .expect("SVG artifacts")
                .next()
                .is_some()
        );
    }

    #[tokio::test]
    async fn a_second_identical_build_uses_the_cache() {
        if sandbox_runner().is_none() || find_executable("lualatex").is_none() {
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
            profile: BuildProfile::Preview,
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
