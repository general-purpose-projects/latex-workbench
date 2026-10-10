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
import PdfViewer, { type SourceLocation } from "./PdfViewer";
import TerminalPanel from "./TerminalPanel";

type Engine = {
  id: string;
  label: string;
  available: boolean;
  path?: string;
  version?: string;
};

type Project = {
  root: string;
  name: string;
  files: ProjectFile[];
  documents: string[];
  gitBranch?: string;
};

type Diagnostic = { severity: "error" | "warning"; message: string };

type BuildResult = {
  success: boolean;
  cached: boolean;
  durationMs: number;
  pdfPath?: string;
  log: string;
  diagnostics: Diagnostic[];
};

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
  const [engine, setEngine] = useState("lualatex");
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
  const logScrollRef = useRef<HTMLDivElement>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  const pendingSourceLocationRef = useRef<SourceLocation | null>(null);

  useEffect(() => () => {
    if (assetUrl) URL.revokeObjectURL(assetUrl);
  }, [assetUrl]);

  const dirty = content !== savedContent;
  const availableEngines = engines.filter((item) => item.available);
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
  useEffect(() => {
    invoke<Engine[]>("list_engines").then((items) => {
      setEngines(items);
      const preferred = items.find((item) => item.id === "lualatex" && item.available)
        ?? items.find((item) => item.available);
      if (preferred) setEngine(preferred.id);
    });
  }, []);

  const showNotice = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(null), 3200);
  }, []);

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

  const chooseProject = useCallback(async () => {
    const selected = await open({ directory: true, multiple: false, title: "Abrir proyecto LaTeX" });
    if (!selected || Array.isArray(selected)) return;
    try {
      const info = await invoke<Project>("discover_project", { root: selected });
      setProject(info);
      setBuild(null);
      setGitOutput("");
      const rootDocument = info.documents[0] ?? info.files.find((item) => item.path.endsWith(".tex"))?.path ?? "";
      setDocumentRoot(rootDocument);
      if (rootDocument) await loadFile(rootDocument, info);
    } catch (error) {
      showNotice(String(error));
    }
  }, [loadFile, showNotice]);

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
        if (removedDocument) setDocumentRoot(info?.documents[0] ?? "");
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
      setLiveLog((current) => current + event.payload.data);
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

  const compile = useCallback(async (cleanCache = false) => {
    if (!project || !documentRoot || building) return;
    if (dirty && !(await saveCurrent())) return;
    setBuilding(true);
    setLiveLog(cleanCache ? "Limpiando caché de compilación…\n" : "Iniciando compilación…\n");
    setLogFilter("all");
    setBottomOpen(true);
    setBottomTab("build");
    try {
      if (cleanCache) {
        await invoke("clear_build_cache", { projectRoot: project.root });
        setBuild(null);
        setLiveLog("Caché eliminada. Iniciando compilación completa…\n");
      }
      const result = await invoke<BuildResult>("compile_project", {
        request: {
          projectRoot: project.root,
          document: documentRoot,
          engine,
          shellEscape,
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
  }, [building, dirty, documentRoot, engine, project, saveCurrent, shellEscape]);

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
    const value = building ? liveLog : (build?.log ?? gitOutput);
    if (!value.trim()) return;
    try {
      await writeText(value);
      showNotice("Logs copiados al portapapeles");
    } catch (error) {
      showNotice(`No se pudieron copiar los logs: ${String(error)}`);
    }
  }, [build?.log, building, gitOutput, liveLog, showNotice]);

  const runGit = useCallback(async (action: "status" | "fetch" | "pull" | "push") => {
    if (!project) return;
    try {
      const result = await invoke<{ success: boolean; output: string }>("git_action", {
        projectRoot: project.root,
        action,
      });
      setGitOutput(result.output || (result.success ? `Git ${action}: completado` : `Git ${action}: falló`));
      setBottomOpen(true);
      setBottomTab("build");
    } catch (error) {
      setGitOutput(String(error));
      setBottomOpen(true);
      setBottomTab("build");
    }
  }, [project]);

  const exportCurrentPdf = useCallback(async () => {
    if (!build?.pdfPath) return;
    const defaultPath = await invoke<string>("default_download_path", { fileName: basename(build.pdfPath) });
    const destination = await save({
      title: "Exportar PDF",
      defaultPath,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (!destination) return;
    await invoke("export_pdf", { source: build.pdfPath, destination });
    showNotice("PDF exportado correctamente");
  }, [build?.pdfPath, showNotice]);

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
          <div className="engine-readiness">
            {engines.length === 0 ? (
              <span><LoaderCircle className="spin" size={15} /> Detectando compiladores…</span>
            ) : (
              <span><Check size={15} /> {availableEngines.length} compiladores disponibles</span>
            )}
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
          <select value={documentRoot} onChange={(event) => setDocumentRoot(event.target.value)} title="Documento raíz">
            {project.documents.map((document) => <option key={document} value={document}>{document}</option>)}
          </select>
          <select value={engine} onChange={(event) => setEngine(event.target.value)} title="Compilador">
            {engines.map((item) => (
              <option key={item.id} value={item.id} disabled={!item.available}>
                {item.label}{item.available ? "" : " · no instalado"}
              </option>
            ))}
          </select>
          <div className="compile-actions dropdown">
            <button className="compile-button" onClick={() => void compile()} disabled={building || !documentRoot}>
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
              <span className="menu-heading">Compilación completa incremental</span>
              <label className="menu-toggle" title="Permite a LaTeX ejecutar herramientas externas como Inkscape. Úsalo sólo con proyectos de confianza.">
                <input type="checkbox" checked={shellEscape} onChange={(event) => setShellEscape(event.target.checked)} />
                <span><b>Permitir herramientas externas</b><small>Para SVG, minted y procesos auxiliares</small></span>
              </label>
              <button onClick={() => void compile(true)} disabled={building || !documentRoot}>
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
            <button className="icon-button"><Github size={18} /><ChevronDown size={13} /></button>
            <div className="dropdown-menu right">
              <button onClick={() => runGit("status")}><GitPullRequest size={15} /> Estado</button>
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
                <button className="primary empty-compile" onClick={() => void compile()} disabled={building || !documentRoot}>
                  {building ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />} Compilar ahora
                </button>
                <button className="secondary" onClick={() => void compile(true)} disabled={building || !documentRoot}>
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
                  <button onClick={copyLogs} title="Copiar logs" disabled={!(building ? liveLog : (build?.log ?? gitOutput))}>
                    <Copy size={14} /> Copiar logs
                  </button>
                  <button className="bottom-close" onClick={() => setBottomOpen(false)} title="Cerrar panel"><X size={15} /></button>
                </div>
              </div>
              {bottomTab === "build" && (
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
              )}
              <div
                ref={logScrollRef}
                className={`bottom-content ${bottomTab === "build" ? "" : "hidden"}`}
                tabIndex={0}
                aria-label="Registro de compilación"
              >
                {gitOutput && <pre className="git-output"><Github size={14} /> {gitOutput}</pre>}
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

      {notice && <div className="toast"><Check size={16} /> {notice}</div>}
    </main>
  );
}
