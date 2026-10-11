import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { latex } from "codemirror-lang-latex";
import { bibtex } from "codemirror-lang-bib";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  BookOpen,
  Box,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Copy,
  Download,
  FileArchive,
  FileText,
  Folder,
  FolderGit2,
  Github,
  GitPullRequest,
  History,
  LoaderCircle,
  Minus,
  PanelBottom,
  Play,
  Plus,
  RefreshCw,
  SquareTerminal,
  Upload,
  X,
} from "lucide-react";
import FileTree, { type ProjectFile, type TreeAction } from "./FileTree";
import { appendBoundedLog, utf8ByteLength } from "./logging";
import { validateBibliography } from "./bibliography";
import { crossrefToBibtex, normalizeDoi, type CrossrefWork } from "./crossref";
import PdfViewer, { type SourceLocation } from "./PdfViewer";
import TerminalPanel from "./TerminalPanel";

type Engine = {
  id: string;
  label: string;
  available: boolean;
  path?: string;
  version?: string;
};

type BuildProfile = "preview" | "release";
type ProjectTemplate = "article" | "thesis" | "beamer" | "letter" | "ieee" | "acm";
const PROJECT_TEMPLATES: { id: ProjectTemplate; label: string; description: string }[] = [
  { id: "article", label: "Artículo", description: "Resumen, secciones y bibliografía" },
  { id: "thesis", label: "Tesis", description: "Capítulos, portada y tabla de contenido" },
  { id: "beamer", label: "Presentación", description: "Diapositivas con tema Madrid" },
  { id: "letter", label: "Carta", description: "Remitente, destinatario y cierre" },
  { id: "ieee", label: "Artículo IEEE", description: "Dos columnas; requiere IEEEtran" },
  { id: "acm", label: "Artículo ACM", description: "Formato sigconf; requiere acmart" },
];
type ProjectConfig = {
  version: number;
  mainDocument: string | null;
  engine: string | null;
  profile: BuildProfile;
};
type EnvironmentCheck = {
  id: string;
  label: string;
  available: boolean;
  required: boolean;
  instructions: string;
};
type EnvironmentReport = { engines: Engine[]; checks: EnvironmentCheck[] };

type Project = {
  root: string;
  name: string;
  files: ProjectFile[];
  documents: string[];
  gitBranch?: string;
  warnings?: string[];
  truncated?: boolean;
};

type Diagnostic = { severity: "error" | "warning"; message: string; file?: string; line?: number };

type BuildResult = {
  success: boolean;
  cached: boolean;
  durationMs: number;
  pdfPath?: string;
  log: string;
  diagnostics: Diagnostic[];
};
type ProjectSnapshot = { id: string; fileCount: number };

type BuildLogChunk = { data: string; stream: "stdout" | "stderr" };
type LogLevel = "error" | "warning" | "info";
type LogFilter = "all" | LogLevel;
type LogEntry = { id: number; level: LogLevel; message: string };
type OutlineItem = { command: string; level: number; line: number; title: string };

const SOURCE_EXTENSIONS = ["tex", "bib", "cls", "sty", "bst", "txt", "md", "toml"];
const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "svg"];
const EDITOR_ZOOM_KEY = "latex-workbench.editor-zoom";
const MIN_EDITOR_ZOOM = 50;
const MAX_EDITOR_ZOOM = 180;

function initialEditorZoom() {
  const saved = Number(window.localStorage.getItem(EDITOR_ZOOM_KEY));
  return Number.isFinite(saved)
    ? Math.min(MAX_EDITOR_ZOOM, Math.max(MIN_EDITOR_ZOOM, saved))
    : 100;
}

function basename(path: string) {
  return path.split(/[\\/]/).pop() ?? path;
}

function movedPath(path: string | null, previous: string, next: string) {
  if (!path) return path;
  if (path === previous) return next;
  return path.startsWith(`${previous}/`) ? `${next}${path.slice(previous.length)}` : path;
}

function pathIsInside(path: string | null, entry: string) {
  return path === entry || Boolean(path?.startsWith(`${entry}/`));
}

function isEditable(path: string) {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return SOURCE_EXTENSIONS.includes(extension);
}

function isImage(path: string) {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTENSIONS.includes(extension);
}

function imageMime(path: string) {
  const extension = path.split(".").pop()?.toLowerCase();
  if (extension === "svg") return "image/svg+xml";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  return `image/${extension ?? "png"}`;
}

function logLevel(message: string): LogLevel {
  if (
    /^\s*!/.test(message)
    || /^\s*(?:ERROR|FATAL)\b/i.test(message)
    || /\b(?:LaTeX|Package\s+\S+|Biber|Latexmk)\s+Error\b/i.test(message)
    || /\b(?:Fatal error|Emergency stop|Traceback|TypeError|No PDF)\b/i.test(message)
    || /\b(?:failed|failure|Errors, so I did not)\b/i.test(message)
  ) {
    return "error";
  }
  if (
    /\bwarnings?\b/i.test(message)
    || /^\s*WARN\b/i.test(message)
    || /\b(?:Overfull|Underfull)\b/.test(message)
    || /\bundefined (?:reference|references|citation|citations)\b/i.test(message)
    || /\brerun (?:LaTeX|Biber)\b/i.test(message)
  ) {
    return "warning";
  }
  return "info";
}

function classifyLog(value: string): LogEntry[] {
  if (!value) return [];
  return value.split("\n").map((message, id) => ({ id, level: logLevel(message), message }));
}

const outlineLevels: Record<string, number> = {
  part: 0,
  chapter: 0,
  section: 1,
  subsection: 2,
  subsubsection: 3,
  paragraph: 4,
  subparagraph: 5,
};

function cleanOutlineTitle(value: string) {
  let title = value.replace(/\\texorpdfstring\{([^{}]*)\}\{[^{}]*\}/g, "$1");
  for (let pass = 0; pass < 3; pass += 1) {
    title = title.replace(/\\[a-zA-Z@]+\*?(?:\[[^\]]*\])?\{([^{}]*)\}/g, "$1");
  }
  return title
    .replace(/\\[a-zA-Z@]+\*?/g, "")
    .replace(/[{}]/g, "")
    .replace(/~/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseOutline(value: string): OutlineItem[] {
  const items: OutlineItem[] = [];
  value.split("\n").forEach((sourceLine, index) => {
    const line = sourceLine.replace(/(?<!\\)%.*$/, "");
    const match = line.match(/^\s*\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*(?:\[[^\]]*\]\s*)?\{/);
    if (!match) return;
    const openingBrace = match[0].lastIndexOf("{");
    let depth = 1;
    let title = "";
    for (let position = openingBrace + 1; position < line.length; position += 1) {
      const character = line[position];
      if (character === "{" && line[position - 1] !== "\\") depth += 1;
      if (character === "}" && line[position - 1] !== "\\") depth -= 1;
      if (depth === 0) break;
      title += character;
    }
    const cleanedTitle = cleanOutlineTitle(title);
    if (cleanedTitle) {
      items.push({
        command: match[1],
        level: outlineLevels[match[1]],
        line: index + 1,
        title: cleanedTitle,
      });
    }
  });
  return items;
}

const overleafEditorTheme = EditorView.theme({
  "&": { backgroundColor: "#ffffff", color: "#171717" },
  ".cm-content": { caretColor: "#111111" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#111111" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "#cfe3f6",
  },
  ".cm-activeLine": { backgroundColor: "#edf6fc" },
  ".cm-activeLineGutter": { backgroundColor: "#e4f0f7", color: "#39434a" },
});

const overleafHighlightStyle = HighlightStyle.define([
  { tag: [tags.keyword, tags.definitionKeyword, tags.heading], color: "#0000e6" },
  { tag: [tags.className, tags.variableName, tags.propertyName], color: "#27869b" },
  { tag: [tags.atom, tags.operator, tags.processingInstruction, tags.escape], color: "#6f3ca0" },
  { tag: [tags.comment, tags.lineComment], color: "#2f7d32", fontStyle: "italic" },
  { tag: [tags.string, tags.meta], color: "#a31515" },
  { tag: tags.number, color: "#202020" },
  { tag: tags.invalid, color: "#c62828", textDecoration: "underline" },
]);

export default function App() {
  const [engines, setEngines] = useState<Engine[]>([]);
  const [environmentChecks, setEnvironmentChecks] = useState<EnvironmentCheck[]>([]);
  const [environmentError, setEnvironmentError] = useState<string | null>(null);
  const [environmentLoading, setEnvironmentLoading] = useState(false);
  const [engine, setEngine] = useState("lualatex");
  const [engineSetupOpen, setEngineSetupOpen] = useState(false);
  const [pendingCleanCompile, setPendingCleanCompile] = useState(false);
  const [profile, setProfile] = useState<BuildProfile>("preview");
  const [project, setProject] = useState<Project | null>(null);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [documentRoot, setDocumentRoot] = useState<string>("");
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [assetUrl, setAssetUrl] = useState<string | null>(null);
  const [autosaving, setAutosaving] = useState(false);
  const [building, setBuilding] = useState(false);
  const [build, setBuild] = useState<BuildResult | null>(null);
  const [pdfVersion, setPdfVersion] = useState(0);
  const [bottomOpen, setBottomOpen] = useState(false);
  const [shellEscape, setShellEscape] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [gitOutput, setGitOutput] = useState("");
  const [gitDiff, setGitDiff] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [snapshots, setSnapshots] = useState<ProjectSnapshot[]>([]);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [doi, setDoi] = useState("");
  const [doiWork, setDoiWork] = useState<CrossrefWork | null>(null);
  const [doiLoading, setDoiLoading] = useState(false);
  const [doiError, setDoiError] = useState<string | null>(null);
  const [aiDiagnostic, setAiDiagnostic] = useState<string | null>(null);
  const [aiKey, setAiKey] = useState("");
  const [aiModel, setAiModel] = useState("");
  const [aiExplanation, setAiExplanation] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(225);
  const [editorWidth, setEditorWidth] = useState(600);
  const [bottomHeight, setBottomHeight] = useState(220);
  const [bottomTab, setBottomTab] = useState<"build" | "terminal">("build");
  const [terminalStarted, setTerminalStarted] = useState(false);
  const [liveLog, setLiveLog] = useState("");
  const [logFilter, setLogFilter] = useState<LogFilter>("all");
  const [outlineOpen, setOutlineOpen] = useState(true);
  const [cursorLine, setCursorLine] = useState(1);
  const [editorZoom, setEditorZoom] = useState(initialEditorZoom);
  const [configSaved, setConfigSaved] = useState(false);
  const liveLogBytesRef = useRef({ text: "", byteLength: 0 });
  const environmentInitializedRef = useRef(false);
  const logScrollRef = useRef<HTMLDivElement>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  const pendingSourceLocationRef = useRef<SourceLocation | null>(null);

  useEffect(() => () => {
    if (assetUrl) URL.revokeObjectURL(assetUrl);
  }, [assetUrl]);

  const dirty = content !== savedContent;
  const availableEngines = engines.filter((item) => item.available);
  const selectedEngine = engines.find((item) => item.id === engine);
  const sandboxCheck = environmentChecks.find((item) => item.id === "sandbox");
  const sandboxReady = Boolean(sandboxCheck?.available);
  const selectedEngineReady = engine === "latexmk"
    ? availableEngines.some((item) => item.id === "latexmk")
      && availableEngines.some((item) => item.id === "pdflatex")
    : availableEngines.some((item) => item.id === engine);
  const profileReady = profile !== "release" || engine === "latexmk";
  const compileDisabled = building || !documentRoot;
  const engineStatus = engine === "latexmk" && selectedEngine?.available
    && !availableEngines.some((item) => item.id === "pdflatex")
    ? "Falta pdfLaTeX"
    : selectedEngine?.available ? "Instalado" : "No instalado";
  const compileBlockReason = environmentError
    ?? (!sandboxReady ? sandboxCheck?.instructions ?? "Revisa los requisitos de aislamiento." : undefined)
    ?? (!selectedEngineReady
      ? engine === "latexmk"
        ? "Latexmk requiere que pdfLaTeX también esté instalado."
        : "El motor seleccionado no está instalado o no está disponible."
      : undefined)
    ?? (!profileReady ? "El perfil Release requiere seleccionar Latexmk." : undefined);
  const currentLog = building ? liveLog : (build?.log ?? "");
  const logEntries = useMemo(() => classifyLog(currentLog), [currentLog]);
  const logCounts = useMemo(() => logEntries.reduce(
    (counts, entry) => ({ ...counts, [entry.level]: counts[entry.level] + 1 }),
    { error: 0, warning: 0, info: 0 } as Record<LogLevel, number>,
  ), [logEntries]);
  const visibleLogEntries = logFilter === "all"
    ? logEntries
    : logEntries.filter((entry) => entry.level === logFilter);
  const outline = useMemo(() => parseOutline(content), [content]);
  const bibliographyIssues = useMemo(
    () => activeFile?.toLowerCase().endsWith(".bib") ? validateBibliography(content) : [],
    [activeFile, content],
  );
  const activeOutlineLine = useMemo(() => {
    let active: number | null = null;
    for (const item of outline) {
      if (item.line > cursorLine) break;
      active = item.line;
    }
    return active;
  }, [cursorLine, outline]);
  const editorExtensions = useMemo(() => [
    activeFile?.toLowerCase().endsWith(".bib")
      ? bibtex({
          enableLinting: false,
          enableTooltips: true,
          enableAutocomplete: true,
          autoCloseBrackets: true,
        })
      : latex({ fileName: activeFile ?? "document.tex" }),
    EditorView.lineWrapping,
    overleafEditorTheme,
    syntaxHighlighting(overleafHighlightStyle),
    EditorView.updateListener.of((update) => {
      if (update.selectionSet || update.docChanged) {
        setCursorLine(update.state.doc.lineAt(update.state.selection.main.head).number);
      }
    }),
  ], [activeFile]);
  const refreshEnvironment = useCallback(async () => {
    setEnvironmentLoading(true);
    setEnvironmentError(null);
    try {
      const report = await invoke<EnvironmentReport>("diagnose_environment");
      setEngines(report.engines);
      setEnvironmentChecks(report.checks);
      if (!environmentInitializedRef.current) {
        environmentInitializedRef.current = true;
        setEngine((current) => report.engines.some((item) => item.id === current && item.available)
          ? current
          : (report.engines.find((item) => item.id === "lualatex" && item.available)
            ?? report.engines.find((item) => item.available)
            ?? { id: current }).id);
      }
    } catch (error) {
      setEnvironmentError(String(error));
    } finally {
      setEnvironmentLoading(false);
    }
  }, []);

  useEffect(() => { void refreshEnvironment(); }, [refreshEnvironment]);

  useEffect(() => {
    if (!engineSetupOpen && !historyOpen && !aiDiagnostic) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setEngineSetupOpen(false);
      setHistoryOpen(false);
      setAiDiagnostic(null);
      setAiKey("");
      setAiExplanation("");
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [aiDiagnostic, engineSetupOpen, historyOpen]);

  const showNotice = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(null), 3200);
  }, []);

  const downloadEngine = useCallback(async (engineId: string) => {
    try {
      await invoke("open_engine_download", { engine: engineId });
    } catch (error) {
      showNotice(`No se pudo abrir la página de descarga: ${String(error)}`);
    }
  }, [showNotice]);

  const changeEditorZoom = useCallback((delta: number) => {
    setEditorZoom((current) => Math.min(MAX_EDITOR_ZOOM, Math.max(MIN_EDITOR_ZOOM, current + delta)));
  }, []);

  useEffect(() => {
    window.localStorage.setItem(EDITOR_ZOOM_KEY, String(editorZoom));
  }, [editorZoom]);

  const loadFile = useCallback(async (path: string, currentProject = project, skipDirtyCheck = false) => {
    if (!currentProject || (!isEditable(path) && !isImage(path))) return false;
    if (!skipDirtyCheck && dirty && activeFile && path !== activeFile) {
      const proceed = window.confirm("Hay cambios sin guardar. ¿Deseas descartarlos?");
      if (!proceed) return false;
    }
    try {
      if (isImage(path)) {
        const value = await invoke<ArrayBuffer>("read_project_asset", {
          projectRoot: currentProject.root,
          path,
        });
        setAssetUrl(URL.createObjectURL(new Blob([new Uint8Array(value)], { type: imageMime(path) })));
        setActiveFile(path);
        setContent("");
        setSavedContent("");
        setCursorLine(1);
        return true;
      }
      const value = await invoke<string>("read_project_file", {
        projectRoot: currentProject.root,
        path,
      });
      setActiveFile(path);
      setContent(value);
      setSavedContent(value);
      setAssetUrl(null);
      setCursorLine(1);
      return true;
    } catch (error) {
      showNotice(String(error));
      return false;
    }
  }, [activeFile, dirty, project, showNotice]);

  const openProjectAt = useCallback(async (root: string) => {
    try {
      const info = await invoke<Project>("discover_project", { root });
      const config = await invoke<ProjectConfig>("load_project_config", { projectRoot: info.root });
      const documents = config.mainDocument && !info.documents.includes(config.mainDocument)
        ? [...info.documents, config.mainDocument].sort()
        : info.documents;
      const projectInfo = { ...info, documents };
      setProject(projectInfo);
      setBuild(null);
      setGitOutput("");
      setGitDiff("");
      const rootDocument = config.mainDocument
        ?? documents[0]
        ?? info.files.find((item) => item.path.endsWith(".tex"))?.path
        ?? "";
      setDocumentRoot(rootDocument);
      setProfile(config.profile);
      if (config.engine) setEngine(config.engine);
      setConfigSaved(Boolean(config.mainDocument || config.engine || config.profile !== "preview"));
      if (info.warnings?.length || info.truncated) {
        showNotice([
          ...(info.truncated ? ["El árbol alcanzó el límite de 10.000 entradas."] : []),
          ...(info.warnings ?? []),
        ].join(" "));
      }
      if (rootDocument) await loadFile(rootDocument, projectInfo);
    } catch (error) {
      showNotice(String(error));
    }
  }, [loadFile, showNotice]);

  const chooseProject = useCallback(async () => {
    const selected = await open({ directory: true, multiple: false, title: "Abrir proyecto LaTeX" });
    if (!selected || Array.isArray(selected)) return;
    await openProjectAt(selected);
  }, [openProjectAt]);

  const createProjectFromTemplate = useCallback(async (template: ProjectTemplate) => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Elige una carpeta vacía para el nuevo proyecto",
    });
    if (!selected || Array.isArray(selected)) return;
    try {
      await invoke("create_project_from_template", { projectRoot: selected, template });
      await openProjectAt(selected);
    } catch (error) {
      showNotice(String(error));
    }
  }, [openProjectAt, showNotice]);

  const saveProjectSettings = useCallback(async () => {
    if (!project) return;
    try {
      await invoke("save_project_config", {
        projectRoot: project.root,
        config: {
          version: 1,
          mainDocument: documentRoot || null,
          engine,
          profile,
        },
      });
      setConfigSaved(true);
      showNotice("Configuración guardada en .latex-workbench.json");
    } catch (error) {
      showNotice(`No se pudo guardar la configuración: ${String(error)}`);
    }
  }, [documentRoot, engine, profile, project, showNotice]);

  const saveCurrent = useCallback(async () => {
    if (!project || !activeFile) return false;
    if (!isEditable(activeFile)) return true;
    try {
      await invoke("write_project_file", {
        projectRoot: project.root,
        path: activeFile,
        content,
      });
      setSavedContent(content);
      return true;
    } catch (error) {
      showNotice(String(error));
      return false;
    }
  }, [activeFile, content, project, showNotice]);

  const rediscoverProject = useCallback(async () => {
    if (!project) return null;
    const info = await invoke<Project>("discover_project", { root: project.root });
    setProject(info);
    return info;
  }, [project]);

  const importFiles = useCallback(async (sources: string[], directory: string) => {
    if (!project || sources.length === 0) return;
    let replacingDirtyActive = false;
    try {
      const conflicts = await invoke<string[]>("project_import_conflicts", {
        projectRoot: project.root,
        sources,
        directory,
      });
      let overwrite = false;
      if (conflicts.length > 0) {
        const preview = conflicts.slice(0, 6).map((path) => `• ${path}`).join("\n");
        const remainder = conflicts.length > 6 ? `\n…y ${conflicts.length - 6} más` : "";
        overwrite = window.confirm(
          `Ya ${conflicts.length === 1 ? "existe este archivo" : "existen estos archivos"}:\n\n${preview}${remainder}\n\n¿Deseas reemplazar ${conflicts.length === 1 ? "el archivo" : "los archivos"}?`,
        );
        if (!overwrite) return;
      }
      replacingDirtyActive = Boolean(activeFile && dirty && conflicts.includes(activeFile));
      if (replacingDirtyActive) setSavedContent(content);
      const imported = await invoke<string[]>("import_project_files", {
        projectRoot: project.root,
        sources,
        directory,
        overwrite,
      });
      const info = await rediscoverProject();
      setBuild(null);
      if (info && activeFile && imported.includes(activeFile)) await loadFile(activeFile, info, true);
      showNotice(imported.length === 1 ? `Archivo importado: ${imported[0]}` : `${imported.length} archivos importados`);
    } catch (error) {
      if (replacingDirtyActive) setSavedContent(savedContent);
      showNotice(`No se pudieron importar los archivos: ${String(error)}`);
    }
  }, [activeFile, content, dirty, loadFile, project, rediscoverProject, savedContent, showNotice]);

  const handleTreeAction = useCallback(async (action: TreeAction, item: ProjectFile | null, directory: string) => {
    if (!project) return;
    try {
      if (action === "open" && item?.kind === "file") {
        await loadFile(item.path);
        return;
      }
      if (action === "upload") {
        const selected = await open({ multiple: true, directory: false, title: "Importar archivos al proyecto" });
        if (!selected) return;
        await importFiles(Array.isArray(selected) ? selected : [selected], directory);
        return;
      }
      if (action === "new-file" || action === "new-folder") {
        const kind = action === "new-file" ? "file" : "directory";
        if (kind === "file" && dirty && !(await saveCurrent())) return;
        const name = window.prompt(action === "new-file" ? "Nombre del nuevo archivo" : "Nombre de la nueva carpeta", action === "new-file" ? "nuevo.tex" : "nueva-carpeta");
        if (!name?.trim()) return;
        const created = await invoke<string>("create_project_entry", {
          projectRoot: project.root,
          directory,
          name: name.trim(),
          kind,
        });
        const info = await rediscoverProject();
        if (kind === "file" && info && (isEditable(created) || isImage(created))) await loadFile(created, info, true);
        showNotice(`${kind === "file" ? "Archivo" : "Carpeta"} creado`);
        return;
      }
      if (!item) return;
      if (action === "set-main") {
        setDocumentRoot(item.path);
        setConfigSaved(false);
        setBuild(null);
        showNotice(`Documento principal: ${item.path}`);
        return;
      }
      if (action === "download" && item.kind === "file") {
        if (activeFile === item.path && dirty && !(await saveCurrent())) return;
        const defaultPath = await invoke<string>("default_download_path", { fileName: item.name });
        const destination = await save({ title: `Descargar ${item.name}`, defaultPath });
        if (!destination) return;
        await invoke("export_project_file", { projectRoot: project.root, path: item.path, destination });
        showNotice("Archivo descargado correctamente");
        return;
      }
      if (action === "rename") {
        if (pathIsInside(activeFile, item.path) && dirty && !(await saveCurrent())) return;
        const name = window.prompt("Nuevo nombre", item.name);
        if (!name?.trim() || name.trim() === item.name) return;
        const renamed = await invoke<string>("rename_project_entry", {
          projectRoot: project.root,
          path: item.path,
          newName: name.trim(),
        });
        const nextActive = movedPath(activeFile, item.path, renamed);
        const nextDocument = movedPath(documentRoot, item.path, renamed) ?? "";
        const info = await rediscoverProject();
        setDocumentRoot(nextDocument);
        if (nextDocument !== documentRoot) setConfigSaved(false);
        setBuild(null);
        if (info && nextActive && pathIsInside(nextActive, renamed)) await loadFile(nextActive, info, true);
        showNotice("Elemento renombrado");
        return;
      }
      if (action === "delete") {
        const description = item.kind === "directory" ? `la carpeta “${item.name}” y todo su contenido` : `el archivo “${item.name}”`;
        if (!window.confirm(`¿Deseas eliminar ${description}? Esta acción no se puede deshacer.`)) return;
        await invoke("remove_project_entry", { projectRoot: project.root, path: item.path });
        const removedActive = pathIsInside(activeFile, item.path);
        const removedDocument = pathIsInside(documentRoot, item.path);
        const info = await rediscoverProject();
        if (removedActive) {
          setActiveFile(null);
          setContent("");
          setSavedContent("");
          setAssetUrl(null);
        }
        if (removedDocument) {
          setDocumentRoot(info?.documents[0] ?? "");
          setConfigSaved(false);
        }
        setBuild(null);
        showNotice("Elemento eliminado");
      }
    } catch (error) {
      showNotice(String(error));
    }
  }, [activeFile, dirty, documentRoot, importFiles, loadFile, project, rediscoverProject, saveCurrent, showNotice]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveCurrent();
        return;
      }
      const target = event.target instanceof Element ? event.target : null;
      if ((!event.metaKey && !event.ctrlKey) || !target?.closest(".editor-pane")) return;
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        changeEditorZoom(10);
      } else if (event.key === "-") {
        event.preventDefault();
        changeEditorZoom(-10);
      } else if (event.key === "0") {
        event.preventDefault();
        setEditorZoom(100);
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [changeEditorZoom, saveCurrent]);

  useEffect(() => {
    if (!project || !activeFile || !isEditable(activeFile) || !dirty) return;
    let cancelled = false;
    const snapshot = content;
    const timer = window.setTimeout(() => {
      setAutosaving(true);
      void invoke("write_project_file", {
        projectRoot: project.root,
        path: activeFile,
        content: snapshot,
      }).then(() => {
        if (!cancelled) setSavedContent(snapshot);
      }).catch((error) => {
        if (!cancelled) showNotice(`No se pudo guardar automáticamente: ${String(error)}`);
      }).finally(() => {
        if (!cancelled) setAutosaving(false);
      });
    }, 550);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeFile, content, dirty, project, showNotice]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<BuildLogChunk>("build-log", (event) => {
      const next = appendBoundedLog(liveLogBytesRef.current, event.payload.data);
      liveLogBytesRef.current = next;
      setLiveLog(next.text);
    }).then((stop) => { unlisten = stop; });
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    if (!build?.log || !logScrollRef.current) return;
    logScrollRef.current.scrollTo({ top: 0, left: 0 });
  }, [build?.log]);

  useEffect(() => {
    if (!building || !logScrollRef.current) return;
    logScrollRef.current.scrollTo({ top: logScrollRef.current.scrollHeight });
  }, [building, liveLog]);

  const compile = useCallback(async (cleanCache = false, confirmedFirstCompile = false) => {
    if (!project || !documentRoot || building) {
      return;
    }
    if (!confirmedFirstCompile && window.localStorage.getItem("latex-workbench.first-compile-notice") !== "shown") {
      setPendingCleanCompile(cleanCache);
      setEngineSetupOpen(true);
      return;
    }
    if (compileBlockReason) {
      showNotice(compileBlockReason);
      return;
    }
    if (dirty && !(await saveCurrent())) return;
    setBuilding(true);
    const initialLog = cleanCache ? "Limpiando caché de compilación…\n" : "Iniciando compilación…\n";
    liveLogBytesRef.current = { text: initialLog, byteLength: utf8ByteLength(initialLog) };
    setLiveLog(initialLog);
    setLogFilter("all");
    setBottomOpen(true);
    setBottomTab("build");
    try {
      if (cleanCache) {
        await invoke("clear_build_cache", { projectRoot: project.root });
        setBuild(null);
        const cleanLog = "Caché eliminada. Iniciando compilación completa…\n";
        liveLogBytesRef.current = { text: cleanLog, byteLength: utf8ByteLength(cleanLog) };
        setLiveLog(cleanLog);
      }
      const result = await invoke<BuildResult>("compile_project", {
        request: {
          projectRoot: project.root,
          document: documentRoot,
          engine,
          shellEscape,
          profile,
        },
      });
      setBuild(result);
      if (result.pdfPath) setPdfVersion((version) => version + 1);
    } catch (error) {
      setBuild({
        success: false,
        cached: false,
        durationMs: 0,
        log: String(error),
        diagnostics: [{ severity: "error", message: String(error) }],
      });
    } finally {
      setBuilding(false);
    }
  }, [building, compileBlockReason, dirty, documentRoot, engine, profile, project, saveCurrent, shellEscape, showNotice]);

  const jumpToOutline = useCallback((item: OutlineItem) => {
    const view = editorViewRef.current;
    if (!view || item.line > view.state.doc.lines) return;
    const line = view.state.doc.line(item.line);
    view.dispatch({
      selection: { anchor: line.from },
      effects: EditorView.scrollIntoView(line.from, { y: "start", yMargin: 24 }),
    });
    view.focus();
    setCursorLine(item.line);
  }, []);

  const revealSourceLocation = useCallback((view: EditorView, location: SourceLocation) => {
    const lineNumber = Math.min(Math.max(location.line, 1), view.state.doc.lines);
    const line = view.state.doc.line(lineNumber);
    const anchor = Math.min(line.to, line.from + Math.max(0, location.column));
    view.dispatch({
      selection: { anchor },
      effects: EditorView.scrollIntoView(anchor, { y: "center", yMargin: 48 }),
    });
    view.focus();
    setCursorLine(lineNumber);
  }, []);

  const openSourceLocation = useCallback(async (location: SourceLocation) => {
    pendingSourceLocationRef.current = location;
    if (activeFile === location.path && editorViewRef.current) {
      revealSourceLocation(editorViewRef.current, location);
      pendingSourceLocationRef.current = null;
    } else {
      if (dirty && !(await saveCurrent())) {
        pendingSourceLocationRef.current = null;
        return;
      }
      const loaded = await loadFile(location.path, project, true);
      if (!loaded) {
        pendingSourceLocationRef.current = null;
        return;
      }
    }
    showNotice(`${location.path} · línea ${location.line}`);
  }, [activeFile, dirty, loadFile, project, revealSourceLocation, saveCurrent, showNotice]);

  const copyLogs = useCallback(async () => {
    const value = building ? liveLog : gitOutput
      ? `${gitOutput}${gitDiff ? `\n\n${gitDiff}` : ""}`
      : (build?.log ?? "");
    if (!value.trim()) return;
    try {
      await writeText(value);
      showNotice("Logs copiados al portapapeles");
    } catch (error) {
      showNotice(`No se pudieron copiar los logs: ${String(error)}`);
    }
  }, [build?.log, building, gitDiff, gitOutput, liveLog, showNotice]);

  const lookupDoi = useCallback(async () => {
    const normalized = normalizeDoi(doi);
    if (!/^10\.\d{4,9}\/\S+$/i.test(normalized)) {
      setDoiError("Escribe un DOI válido, por ejemplo 10.1000/xyz123.");
      setDoiWork(null);
      return;
    }
    setDoiLoading(true);
    setDoiError(null);
    setDoiWork(null);
    try {
      const response = await fetch(`https://api.crossref.org/works/${encodeURIComponent(normalized)}`, {
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error(response.status === 404 ? "Crossref no encontró ese DOI." : `Crossref respondió ${response.status}.`);
      const payload = await response.json() as { message?: CrossrefWork };
      if (!payload.message?.DOI) throw new Error("La respuesta no contiene metadatos bibliográficos.");
      setDoiWork(payload.message);
    } catch (error) {
      setDoiError(`No se pudo consultar Crossref: ${String(error)}`);
    } finally {
      setDoiLoading(false);
    }
  }, [doi]);

  const addDoiReference = useCallback(() => {
    if (!doiWork) return;
    const entry = crossrefToBibtex(doiWork);
    const separator = content.trim() ? (content.trimEnd().endsWith("}") ? "\n\n" : "\n") : "";
    setContent(`${content}${separator}${entry}\n`);
    setDoiWork(null);
    setDoi("");
    showNotice("Referencia añadida al borrador. Guarda el archivo para conservarla.");
  }, [content, doiWork, showNotice]);

  const explainDiagnosticWithAi = useCallback(async () => {
    if (!aiDiagnostic || !aiKey.trim() || !aiModel.trim()) return;
    setAiLoading(true);
    setAiError(null);
    setAiExplanation("");
    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${aiKey.trim()}`,
        },
        body: JSON.stringify({
          model: aiModel.trim(),
          messages: [
            { role: "system", content: "Explica errores de compilación LaTeX en español claro. Da causa probable, pasos concretos de diagnóstico y una corrección mínima. No inventes el contenido de archivos no proporcionados." },
            { role: "user", content: `Explica este único diagnóstico de compilación:\n${aiDiagnostic}` },
          ],
          temperature: 0.2,
        }),
      });
      const payload = await response.json() as {
        choices?: { message?: { content?: string } }[];
        error?: { message?: string };
      };
      if (!response.ok) throw new Error(payload.error?.message ?? `OpenAI respondió ${response.status}.`);
      const explanation = payload.choices?.[0]?.message?.content?.trim();
      if (!explanation) throw new Error("La respuesta no incluyó una explicación.");
      setAiExplanation(explanation);
    } catch (error) {
      setAiError(`No se pudo obtener la explicación: ${String(error)}`);
    } finally {
      setAiLoading(false);
    }
  }, [aiDiagnostic, aiKey, aiModel]);

  const runGit = useCallback(async (action: "status" | "changes" | "fetch" | "pull" | "push") => {
    if (!project) return;
    if (action === "pull" && !window.confirm("Se descargarán cambios remotos. ¿Continuar?")) return;
    if (action === "push" && !window.confirm("Se publicarán los commits locales en el remoto. ¿Continuar?")) return;
    try {
      const result = await invoke<{ success: boolean; output: string; status?: string; diff?: string }>("git_action", {
        projectRoot: project.root,
        action,
      });
      if (action === "changes") {
        setGitOutput(result.status || (result.success ? "Sin cambios Git." : "No se pudo consultar el estado Git."));
        setGitDiff(result.diff || "");
      } else {
        setGitOutput(result.output || (result.success ? `Git ${action}: completado` : `Git ${action}: falló`));
        setGitDiff("");
      }
      setBottomOpen(true);
      setBottomTab("build");
    } catch (error) {
      setGitOutput(String(error));
      setGitDiff("");
      setBottomOpen(true);
      setBottomTab("build");
    }
  }, [project]);

  const exportCurrentPdf = useCallback(async () => {
    if (!project || !build?.pdfPath) return;
    const defaultPath = await invoke<string>("default_download_path", { fileName: basename(build.pdfPath) });
    const destination = await save({
      title: "Exportar PDF",
      defaultPath,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (!destination) return;
    await invoke("export_pdf", {
      projectRoot: project.root,
      source: build.pdfPath,
      destination,
    });
    showNotice("PDF exportado correctamente");
  }, [build?.pdfPath, project, showNotice]);

  const exportProject = useCallback(async () => {
    if (!project) return;
    const defaultPath = await invoke<string>("default_download_path", { fileName: `${project.name}.zip` });
    const destination = await save({
      title: "Exportar código fuente",
      defaultPath,
      filters: [{ name: "Archivo ZIP", extensions: ["zip"] }],
    });
    if (!destination) return;
    await invoke("export_sources", { projectRoot: project.root, destination });
    showNotice("Fuentes exportadas correctamente");
  }, [project, showNotice]);

  const openTerminal = useCallback(() => {
    setTerminalStarted(true);
    setBottomTab("terminal");
    setBottomOpen(true);
  }, []);

  const refreshSnapshots = useCallback(async () => {
    if (!project) return;
    setSnapshotLoading(true);
    try {
      const items = await invoke<ProjectSnapshot[]>("list_project_snapshots", { projectRoot: project.root });
      setSnapshots(items);
    } catch (error) {
      showNotice(`No se pudo consultar el historial local: ${String(error)}`);
    } finally {
      setSnapshotLoading(false);
    }
  }, [project, showNotice]);

  const saveSnapshot = useCallback(async () => {
    if (!project) return;
    if (dirty && !(await saveCurrent())) return;
    setSnapshotLoading(true);
    try {
      await invoke<ProjectSnapshot>("create_project_snapshot_command", { projectRoot: project.root });
      await refreshSnapshots();
      showNotice("Punto de restauración local guardado");
    } catch (error) {
      showNotice(`No se pudo guardar el punto de restauración: ${String(error)}`);
    } finally {
      setSnapshotLoading(false);
    }
  }, [dirty, project, refreshSnapshots, saveCurrent, showNotice]);

  const restoreSnapshot = useCallback(async (snapshot: ProjectSnapshot) => {
    if (!project) return;
    if (dirty && !(await saveCurrent())) return;
    const timestamp = new Date(Number(snapshot.id) / 1_000_000).toLocaleString();
    if (!window.confirm(`Restaurar los ${snapshot.fileCount} archivos del punto ${timestamp}? Los archivos correspondientes se sobrescribirán; los archivos creados después no se eliminarán.`)) return;
    setSnapshotLoading(true);
    try {
      await invoke<ProjectSnapshot>("restore_project_snapshot", {
        projectRoot: project.root,
        snapshotId: snapshot.id,
      });
      await openProjectAt(project.root);
      await refreshSnapshots();
      showNotice("Punto de restauración aplicado");
    } catch (error) {
      showNotice(`No se pudo restaurar el punto: ${String(error)}`);
    } finally {
      setSnapshotLoading(false);
    }
  }, [dirty, openProjectAt, project, refreshSnapshots, saveCurrent, showNotice]);

  const beginResize = useCallback((kind: "sidebar" | "editor" | "bottom", event: React.PointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const initialSidebar = sidebarWidth;
    const initialEditor = editorWidth;
    const initialBottom = bottomHeight;
    document.body.classList.add("is-resizing", `resize-${kind}`);

    const move = (moveEvent: PointerEvent) => {
      if (kind === "sidebar") {
        setSidebarWidth(Math.min(440, Math.max(165, initialSidebar + moveEvent.clientX - startX)));
      } else if (kind === "editor") {
        const maximum = Math.max(360, window.innerWidth - sidebarWidth - 380);
        setEditorWidth(Math.min(maximum, Math.max(320, initialEditor + moveEvent.clientX - startX)));
      } else {
        setBottomHeight(Math.min(520, Math.max(120, initialBottom + startY - moveEvent.clientY)));
      }
    };
    const finish = () => {
      document.body.classList.remove("is-resizing", `resize-${kind}`);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
  }, [bottomHeight, editorWidth, sidebarWidth]);

  if (!project) {
    return (
      <main className="welcome-shell">
        <section className="welcome-card">
          <div className="brand-mark"><Code2 size={30} /></div>
          <span className="eyebrow">LATEX WORKBENCH</span>
          <h1>Compila menos.<br />Escribe más.</h1>
          <p>Un entorno local para cualquier proyecto LaTeX, con múltiples motores, Git y exportaciones reproducibles.</p>
          <button className="primary large" onClick={chooseProject}>
            <Folder size={18} /> Abrir proyecto
          </button>
          <div className="template-heading">
            <strong>O empieza con una plantilla</strong>
            <span>Se creará solo dentro de una carpeta vacía que elijas.</span>
          </div>
          <div className="template-grid">
            {PROJECT_TEMPLATES.map((template, index) => (
              <button
                className="template-card"
                key={template.id}
                onClick={() => void createProjectFromTemplate(template.id)}
              >
                {index % 2 === 0 ? <BookOpen size={17} /> : <FileText size={17} />}
                <span><b>{template.label}</b><small>{template.description}</small></span>
                <ChevronRight size={15} />
              </button>
            ))}
          </div>
          <div className="engine-readiness">
            {environmentLoading && <span><LoaderCircle className="spin" size={15} /> Revisando requisitos…</span>}
            {environmentError && <span className="environment-error">{environmentError}</span>}
            {environmentChecks.map((check) => (
              <div className={`environment-check ${check.available ? "available" : "unavailable"}`} key={check.id}>
                {check.available ? <Check size={14} /> : <X size={14} />}
                <span><b>{check.label}</b>{!check.available && <> — {check.instructions}</>}</span>
                {!check.required && <small>opcional</small>}
              </div>
            ))}
            <button className="environment-refresh" onClick={() => void refreshEnvironment()} disabled={environmentLoading}>
              <RefreshCw size={13} /> Volver a comprobar
            </button>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand"><div className="brand-dot" /><strong>Latex Workbench</strong></div>
        <div className="project-identity">
          <span>{project.name}</span>
          {project.gitBranch && <small><FolderGit2 size={13} /> {project.gitBranch}</small>}
        </div>
        <div className="toolbar">
          <select value={documentRoot} onChange={(event) => { setDocumentRoot(event.target.value); setConfigSaved(false); }} title="Documento raíz">
            {project.documents.map((document) => <option key={document} value={document}>{document}</option>)}
          </select>
          <div className="engine-control">
            <select value={engine} onChange={(event) => { setEngine(event.target.value); setConfigSaved(false); }} title="Compilador">
              {engines.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}{item.available ? " · instalado" : " · no instalado"}
                </option>
              ))}
            </select>
            <span
              className={`engine-status ${selectedEngineReady ? "installed" : "missing"}`}
              title={selectedEngineReady ? `${selectedEngine?.label ?? engine}: instalado` : `${selectedEngine?.label ?? engine}: no instalado`}
            >
              {selectedEngineReady ? <Check size={11} /> : <X size={11} />}
              {engineStatus}
            </span>
            <div className="dropdown engine-downloads">
              <button className="engine-download-button" title="Descargar motores LaTeX" aria-label="Descargar motores LaTeX">
                <Download size={14} />
              </button>
              <div className="dropdown-menu engine-download-menu">
                <span className="menu-heading">Últimas versiones oficiales</span>
                {engines.map((item) => (
                  <button key={item.id} onClick={() => void downloadEngine(item.id)}>
                    <Download size={14} />
                    <span>{item.label}<small>{item.available ? "Ya está instalado" : "Descargar o instalar"}</small></span>
                  </button>
                ))}
              </div>
            </div>
          </div>
          <select value={profile} onChange={(event) => { setProfile(event.target.value as BuildProfile); setConfigSaved(false); }} title="Perfil de compilación">
            <option value="preview">Vista previa</option>
            <option value="release">Release</option>
          </select>
          <div className="compile-actions dropdown">
            <button
              className="compile-button"
              onClick={() => void compile()}
              disabled={compileDisabled}
              title={building ? undefined : compileBlockReason}
            >
              {building ? <LoaderCircle className="spin" size={16} /> : <Play size={16} fill="currentColor" />}
              {building ? "Compilando" : "Compilar"}
            </button>
            <button
              className="clean-compile-button"
              title="Opciones de compilación"
              aria-label="Opciones de compilación"
            >
              <ChevronDown size={15} />
            </button>
            <div className="dropdown-menu compile-menu">
              <span className="menu-heading">{profile === "release" ? "Compilación limpia para distribución" : "Vista previa incremental"}</span>
              <button onClick={() => void saveProjectSettings()}>
                <Check size={14} /> {configSaved ? "Configuración guardada" : "Guardar configuración del proyecto"}
              </button>
              {compileBlockReason && <small className="profile-warning">{compileBlockReason}</small>}
              <button onClick={() => void refreshEnvironment()} disabled={environmentLoading}>
                <RefreshCw size={14} /> Revisar requisitos del entorno
              </button>
              <label className="menu-toggle" title="Permite a LaTeX ejecutar herramientas externas como Inkscape. Úsalo sólo con proyectos de confianza.">
                <input type="checkbox" checked={shellEscape} onChange={(event) => setShellEscape(event.target.checked)} />
                <span><b>Permitir herramientas externas</b><small>Para SVG, minted y procesos auxiliares</small></span>
              </label>
              <button onClick={() => void compile(true)} disabled={compileDisabled}>
                <RefreshCw size={14} /> Limpiar caché y compilar
              </button>
            </div>
          </div>
          <div className="dropdown">
            <button className="icon-button download-button" title="Descargar"><Download size={18} /><ChevronDown size={13} /></button>
            <div className="dropdown-menu right">
              <button onClick={exportCurrentPdf} disabled={!build?.pdfPath}><FileText size={15} /> Exportar PDF</button>
              <button onClick={exportProject}><FileArchive size={15} /> Exportar fuentes ZIP</button>
            </div>
          </div>
          <div className="dropdown">
            <button className="icon-button" title="Acciones de Git" aria-label="Acciones de Git"><Github size={18} /><ChevronDown size={13} /></button>
            <div className="dropdown-menu right">
              <button onClick={() => runGit("status")}><GitPullRequest size={15} /> Estado</button>
              <button onClick={() => runGit("changes")}><Code2 size={15} /> Revisar cambios</button>
              <button onClick={() => { setHistoryOpen(true); void refreshSnapshots(); }}><History size={15} /> Historial local</button>
              <button onClick={() => runGit("fetch")}><RefreshCw size={15} /> Fetch</button>
              <button onClick={() => runGit("pull")}><Download size={15} /> Pull</button>
              <button onClick={() => runGit("push")}><Upload size={15} /> Push</button>
            </div>
          </div>
        </div>
      </header>

      <section
        className={`workspace ${bottomOpen ? "with-bottom" : ""}`}
        style={{
          gridTemplateColumns: `${sidebarWidth}px 5px ${editorWidth}px 5px minmax(320px, 1fr)`,
          gridTemplateRows: bottomOpen ? `minmax(260px, 1fr) 5px ${bottomHeight}px` : "minmax(0, 1fr)",
        }}
      >
        <aside className="sidebar">
          <div className="sidebar-title">
            <span>ARCHIVOS</span>
            <button onClick={chooseProject} title="Abrir proyecto"><Folder size={14} /> Abrir proyecto</button>
          </div>
          <FileTree
            key={project.root}
            files={project.files}
            activeFile={activeFile}
            documentRoot={documentRoot}
            onOpen={loadFile}
            onAction={handleTreeAction}
            onImportFiles={importFiles}
          />
          <section className={`file-outline ${outlineOpen ? "open" : "collapsed"}`}>
            <button
              className="outline-title"
              onClick={() => setOutlineOpen((value) => !value)}
              aria-expanded={outlineOpen}
            >
              {outlineOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <BookOpen size={14} />
              <span>ESQUEMA DEL ARCHIVO</span>
              <small>{outline.length}</small>
            </button>
            {outlineOpen && (
              <div className="outline-tree" role="tree" aria-label="Secciones del archivo actual">
                {outline.length ? outline.map((item) => (
                  <button
                    key={`${item.line}-${item.command}`}
                    className={`outline-row ${activeOutlineLine === item.line ? "active" : ""}`}
                    style={{ paddingLeft: 11 + item.level * 15 }}
                    onClick={() => jumpToOutline(item)}
                    title={`${item.title} · línea ${item.line}`}
                    role="treeitem"
                    aria-level={item.level + 1}
                  >
                    <span>{item.title}</span>
                    <small>{item.line}</small>
                  </button>
                )) : (
                  <p>No hay capítulos ni secciones en este archivo.</p>
                )}
              </div>
            )}
          </section>
        </aside>

        <div
          className="splitter splitter-vertical sidebar-splitter"
          onPointerDown={(event) => beginResize("sidebar", event)}
          role="separator"
          aria-label="Cambiar ancho del árbol de archivos"
        />

        <section className="editor-pane">
          <div className="pane-header">
            <nav className="breadcrumbs" aria-label="Ruta del archivo">
              <Folder size={14} />
              {activeFile?.split("/").map((part, index, parts) => (
                <span className={index === parts.length - 1 ? "current" : ""} key={`${part}-${index}`}>
                  <ChevronRight size={12} /> {part}
                </span>
              ))}
              {dirty && <b className="dirty-dot">●</b>}
            </nav>
            {activeFile && isEditable(activeFile) && (
              <div className="editor-zoom-controls" role="group" aria-label="Zoom del editor">
                <button
                  onClick={() => changeEditorZoom(-10)}
                  disabled={editorZoom <= MIN_EDITOR_ZOOM}
                  title="Reducir texto (⌘−)"
                  aria-label="Reducir texto"
                >
                  <Minus size={14} />
                </button>
                <button
                  className="editor-zoom-value"
                  onClick={() => setEditorZoom(100)}
                  title="Restablecer zoom (⌘0)"
                  aria-label={`Zoom del editor ${editorZoom}%. Restablecer`}
                >
                  {editorZoom}%
                </button>
                <button
                  onClick={() => changeEditorZoom(10)}
                  disabled={editorZoom >= MAX_EDITOR_ZOOM}
                  title="Aumentar texto (⌘+)"
                  aria-label="Aumentar texto"
                >
                  <Plus size={14} />
                </button>
              </div>
            )}
          </div>
          {activeFile && assetUrl ? (
            <div className="asset-preview">
              <img src={assetUrl} alt={basename(activeFile)} />
              <span>{activeFile}</span>
            </div>
          ) : activeFile && isEditable(activeFile) ? (
            <>
              {activeFile.toLowerCase().endsWith(".bib") && (
                <details className={`bibliography-check ${bibliographyIssues.some((item) => item.severity === "error") ? "has-errors" : bibliographyIssues.length ? "has-warnings" : "is-valid"}`}>
                  <summary>
                    <BookOpen size={14} />
                    {bibliographyIssues.length
                      ? `Bibliografía: ${bibliographyIssues.filter((item) => item.severity === "error").length} errores, ${bibliographyIssues.filter((item) => item.severity === "warning").length} avisos`
                      : "Bibliografía: sin problemas básicos detectados"}
                  </summary>
                  {bibliographyIssues.length > 0 && (
                    <ul>
                      {bibliographyIssues.map((issue, index) => (
                        <li key={`${issue.line}-${index}`} className={issue.severity}>
                          <button onClick={() => {
                            const view = editorViewRef.current;
                            if (!view) return;
                            const line = view.state.doc.line(Math.min(issue.line, view.state.doc.lines));
                            view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: "center" }) });
                            view.focus();
                          }}>
                            Línea {issue.line}: {issue.message}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="doi-import">
                    <label htmlFor="doi-reference">Importar por DOI (consulta Crossref al solicitarla)</label>
                    <div>
                      <input
                        id="doi-reference"
                        value={doi}
                        onChange={(event) => { setDoi(event.target.value); setDoiError(null); setDoiWork(null); }}
                        placeholder="10.1000/xyz123"
                        onKeyDown={(event) => { if (event.key === "Enter") void lookupDoi(); }}
                      />
                      <button onClick={() => void lookupDoi()} disabled={doiLoading || !doi.trim()}>
                        {doiLoading ? "Buscando…" : "Buscar"}
                      </button>
                    </div>
                    <small>Solo se envía el DOI a Crossref; el contenido del documento no se transmite.</small>
                    {doiError && <p role="alert">{doiError}</p>}
                    {doiWork && (
                      <div className="doi-result">
                        <span>{doiWork.title?.[0] ?? doiWork.DOI}</span>
                        <button onClick={addDoiReference}>Añadir al .bib</button>
                      </div>
                    )}
                  </div>
                </details>
              )}
              <CodeMirror
                key={activeFile}
                className="editor-codemirror"
                style={{ "--editor-font-size": `${13 * editorZoom / 100}px` } as CSSProperties}
                value={content}
                height="100%"
                extensions={editorExtensions}
                onCreateEditor={(view) => {
                  editorViewRef.current = view;
                  const pending = pendingSourceLocationRef.current;
                  if (pending && pending.path === activeFile) {
                    window.requestAnimationFrame(() => revealSourceLocation(view, pending));
                    pendingSourceLocationRef.current = null;
                  }
                }}
                onChange={setContent}
                theme="light"
                basicSetup={{
                  lineNumbers: true,
                  foldGutter: true,
                  highlightActiveLine: true,
                  bracketMatching: true,
                  autocompletion: true,
                }}
              />
            </>
          ) : <div className="empty-pane">Selecciona un archivo de texto o una imagen</div>}
        </section>

        <div
          className="splitter splitter-vertical editor-splitter"
          onPointerDown={(event) => beginResize("editor", event)}
          role="separator"
          aria-label="Cambiar ancho del editor"
        />

        <section className="pdf-pane">
          <div className="pane-header">
            <span><FileText size={14} /> VISTA PREVIA</span>
            {build && (
              <small className={build.success ? "success" : "failure"}>
                {build.success ? <Check size={13} /> : <X size={13} />}
                {build.cached ? "caché" : `${(build.durationMs / 1000).toFixed(2)} s`}
              </small>
            )}
          </div>
          {build?.pdfPath ? (
            <PdfViewer
              projectRoot={project.root}
              path={build.pdfPath}
              version={pdfVersion}
              onSourceLocation={(location) => void openSourceLocation(location)}
              onInverseSearchError={showNotice}
            />
          ) : (
            <div className="pdf-empty">
              <div className="paper-ghost"><span>TeX</span></div>
              <h2>Tu PDF aparecerá aquí</h2>
              <p>Selecciona un documento raíz y compílalo.</p>
              <div className="pdf-empty-actions">
                <button className="primary empty-compile" onClick={() => void compile()} disabled={compileDisabled}>
                  {building ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />} Compilar ahora
                </button>
                <button className="secondary" onClick={() => void compile(true)} disabled={compileDisabled}>
                  <RefreshCw size={15} /> Limpiar caché y compilar
                </button>
              </div>
            </div>
          )}
        </section>

        {bottomOpen && (
          <>
            <div
              className="splitter splitter-horizontal bottom-splitter"
              onPointerDown={(event) => beginResize("bottom", event)}
              role="separator"
              aria-label="Cambiar altura del panel inferior"
            />
            <section className="bottom-panel">
              <div className="bottom-header">
                <div className="bottom-tabs">
                  <button
                    className={bottomTab === "build" ? "active" : ""}
                    onClick={() => setBottomTab("build")}
                  >
                    Compilación
                  </button>
                  <button
                    className={bottomTab === "terminal" ? "active" : ""}
                    onClick={openTerminal}
                  >
                    <SquareTerminal size={14} /> Terminal
                  </button>
                </div>
                <div className="bottom-actions">
                  <button onClick={copyLogs} title="Copiar logs o diff Git" disabled={!(building ? liveLog : (gitOutput || build?.log || gitDiff))}>
                    <Copy size={14} /> Copiar logs
                  </button>
                  <button className="bottom-close" onClick={() => setBottomOpen(false)} title="Cerrar panel"><X size={15} /></button>
                </div>
              </div>
              {bottomTab === "build" && (
                <>
                  {build?.diagnostics.length ? (
                    <details className="build-diagnostics" open>
                      <summary>
                        Diagnósticos: {build.diagnostics.filter((item) => item.severity === "error").length} errores,{" "}
                        {build.diagnostics.filter((item) => item.severity === "warning").length} avisos
                      </summary>
                      <ul>
                        {build.diagnostics.map((item, index) => (
                          <li key={`${item.line ?? 0}-${index}`} className={item.severity}>
                            <span>
                              {item.file && item.line ? (
                                <button onClick={() => void openSourceLocation({
                                  path: item.file!,
                                  line: item.line!,
                                  column: 0,
                                })}>
                                  {item.file}:{item.line} — {item.message}
                                </button>
                              ) : item.message}
                            </span>
                            <button className="ai-explain-trigger" onClick={() => {
                              setAiDiagnostic(item.message);
                              setAiError(null);
                              setAiExplanation("");
                            }}>Explicar con IA</button>
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                  <div className="log-filters" role="toolbar" aria-label="Filtrar registro de compilación">
                    {([
                      ["all", "Todos", logEntries.length],
                      ["error", "Errores", logCounts.error],
                      ["warning", "Advertencias", logCounts.warning],
                      ["info", "Info", logCounts.info],
                    ] as const).map(([filter, label, count]) => (
                      <button
                        key={filter}
                        className={`${filter} ${logFilter === filter ? "active" : ""}`}
                        onClick={() => setLogFilter(filter)}
                        aria-pressed={logFilter === filter}
                      >
                        {label} <span>{count}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
              <div
                ref={logScrollRef}
                className={`bottom-content ${bottomTab === "build" ? "" : "hidden"}`}
                tabIndex={0}
                aria-label="Registro de compilación"
              >
                {gitOutput && <pre className="git-output"><Github size={14} /> {gitOutput}</pre>}
                {gitDiff && (
                  <div className="git-diff-container">
                    <small>Diff de archivos versionados; los archivos nuevos se muestran en el estado Git.</small>
                    <pre className="git-diff" aria-label="Diff de cambios Git">{gitDiff}</pre>
                  </div>
                )}
                {currentLog ? (
                  <div className="build-log" role="log" aria-live="polite">
                    {visibleLogEntries.map((entry) => (
                      <div key={entry.id} className={`log-line ${entry.level}`}>
                        <span className="log-level">{entry.level === "error" ? "ERROR" : entry.level === "warning" ? "WARN" : "INFO"}</span>
                        <span className="log-message">{entry.message || " "}</span>
                      </div>
                    ))}
                    {!visibleLogEntries.length && <div className="log-empty">No hay mensajes en esta categoría.</div>}
                  </div>
                ) : <div className="log-empty">Listo para compilar.</div>}
              </div>
              {terminalStarted && (
                <div className={`terminal-panel ${bottomTab === "terminal" ? "" : "hidden"}`}>
                  <TerminalPanel projectRoot={project.root} active={bottomOpen && bottomTab === "terminal"} />
                </div>
              )}
            </section>
          </>
        )}
      </section>

      <footer className="statusbar">
        <span>{autosaving ? "Guardando…" : dirty ? "Pendiente de autoguardado" : "Guardado automáticamente"}</span>
        <span className="spacer" />
        <button onClick={openTerminal}><SquareTerminal size={14} /> Terminal</button>
        <button onClick={() => setBottomOpen((value) => !value)}><PanelBottom size={14} /> Panel</button>
        <span>{project.files.filter((item) => item.kind === "file").length} archivos</span>
        <span><Box size={13} /> {availableEngines.length} motores</span>
      </footer>

      {engineSetupOpen && (
        <div className="setup-modal-backdrop" role="presentation">
          <section className="setup-modal" role="dialog" aria-modal="true" aria-labelledby="engine-setup-title">
            <div className="setup-modal-icon"><Download size={21} /></div>
            <h2 id="engine-setup-title">Antes de compilar</h2>
            <p>
              Latex Workbench no incluye una distribución LaTeX. Usa motores instalados en tu equipo;
              el motor seleccionado, <b>{selectedEngine?.label ?? engine}</b>, figura como <b>{engineStatus.toLowerCase()}</b>.
            </p>
            <p>Si aún no tienes un motor, puedes abrir su página oficial de descarga. Tectonic también está disponible en la lista.</p>
            <div className="setup-modal-engines">
              {engines.map((item) => (
                <button key={item.id} onClick={() => void downloadEngine(item.id)}>
                  <Download size={14} /> Última versión de {item.label}
                  <small>{item.available ? "Instalado" : "No instalado"}</small>
                </button>
              ))}
            </div>
            <button
              className="setup-modal-refresh"
              onClick={() => void refreshEnvironment()}
              disabled={environmentLoading}
            >
              <RefreshCw className={environmentLoading ? "spin" : ""} size={14} />
              Ya lo instalé: volver a comprobar
            </button>
            {!sandboxReady && <p className="setup-modal-warning">{sandboxCheck?.instructions ?? "Falta el aislamiento necesario para compilar."}</p>}
            <div className="setup-modal-actions">
              <button className="secondary" onClick={() => setEngineSetupOpen(false)}>Ahora no</button>
              <button
                className="primary"
                onClick={() => {
                  setEngineSetupOpen(false);
                  window.localStorage.setItem("latex-workbench.first-compile-notice", "shown");
                  void compile(pendingCleanCompile, true);
                }}
              >
                Continuar
              </button>
            </div>
          </section>
        </div>
      )}
      {historyOpen && (
        <div className="setup-modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setHistoryOpen(false);
        }}>
          <section className="setup-modal history-modal" role="dialog" aria-modal="true" aria-labelledby="history-title">
            <div className="setup-modal-icon"><History size={21} /></div>
            <h2 id="history-title">Historial local</h2>
            <p>Los puntos se guardan en la caché privada de Latex Workbench. Se conservan hasta 10; restaurar sobrescribe archivos de ese punto, pero no elimina archivos actuales que no estén en él.</p>
            <div className="history-actions">
              <button className="primary" onClick={() => void saveSnapshot()} disabled={snapshotLoading}>
                {snapshotLoading ? <LoaderCircle className="spin" size={14} /> : <Plus size={14} />} Guardar punto ahora
              </button>
              <button className="secondary" onClick={() => void refreshSnapshots()} disabled={snapshotLoading}>
                <RefreshCw size={14} /> Actualizar
              </button>
            </div>
            {snapshotLoading && <p role="status">Procesando historial…</p>}
            {!snapshotLoading && snapshots.length === 0 && <p>Aún no hay puntos de restauración.</p>}
            <div className="history-list">
              {snapshots.map((snapshot) => (
                <div className="history-item" key={snapshot.id}>
                  <span><b>{new Date(Number(snapshot.id) / 1_000_000).toLocaleString()}</b><small>{snapshot.fileCount} archivos</small></span>
                  <button onClick={() => void restoreSnapshot(snapshot)} disabled={snapshotLoading}>Restaurar</button>
                </div>
              ))}
            </div>
            <div className="setup-modal-actions">
              <button className="secondary" onClick={() => setHistoryOpen(false)}>Cerrar</button>
            </div>
          </section>
        </div>
      )}
      {aiDiagnostic && (
        <div className="setup-modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) {
            setAiDiagnostic(null);
            setAiKey("");
            setAiExplanation("");
          }
        }}>
          <section className="setup-modal ai-modal" role="dialog" aria-modal="true" aria-labelledby="ai-title">
            <div className="setup-modal-icon"><Code2 size={21} /></div>
            <h2 id="ai-title">Explicación opcional con IA</h2>
            <p>Se enviará solo el diagnóstico mostrado a OpenAI. No se enviarán tus archivos ni el resto del log. La clave permanece en memoria y no se guarda.</p>
            <blockquote>{aiDiagnostic}</blockquote>
            <label htmlFor="ai-model">Modelo OpenAI</label>
            <input id="ai-model" value={aiModel} onChange={(event) => setAiModel(event.target.value)} placeholder="Escribe un modelo habilitado en tu cuenta" />
            <label htmlFor="ai-key">Clave API</label>
            <input id="ai-key" type="password" autoComplete="off" value={aiKey} onChange={(event) => setAiKey(event.target.value)} placeholder="sk-…" />
            <div className="ai-modal-actions">
              <button className="primary" onClick={() => void explainDiagnosticWithAi()} disabled={aiLoading || !aiKey.trim() || !aiModel.trim()}>
                {aiLoading ? <LoaderCircle className="spin" size={14} /> : <Code2 size={14} />} Enviar diagnóstico
              </button>
              <button className="secondary" onClick={() => { setAiDiagnostic(null); setAiKey(""); setAiExplanation(""); }}>Cerrar y borrar clave</button>
            </div>
            {aiError && <p role="alert" className="ai-error">{aiError}</p>}
            {aiExplanation && <div className="ai-explanation" aria-live="polite">{aiExplanation}</div>}
          </section>
        </div>
      )}
      {notice && <div className="toast"><Check size={16} /> {notice}</div>}
    </main>
  );
}
