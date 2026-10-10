import { useCallback, useEffect, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { latex } from "codemirror-lang-latex";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  BookOpen,
  Box,
  Check,
  ChevronDown,
  CircleAlert,
  Code2,
  Download,
  FileArchive,
  FileText,
  Folder,
  FolderGit2,
  Github,
  GitPullRequest,
  LoaderCircle,
  PanelBottom,
  Play,
  RefreshCw,
  Save,
  Settings,
  SquareTerminal,
  Upload,
  X,
} from "lucide-react";
import FileTree, { type ProjectFile } from "./FileTree";
import PdfViewer from "./PdfViewer";
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

const SOURCE_EXTENSIONS = ["tex", "bib", "cls", "sty", "bst", "txt", "md", "toml"];

function basename(path: string) {
  return path.split(/[\\/]/).pop() ?? path;
}

function isEditable(path: string) {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return SOURCE_EXTENSIONS.includes(extension);
}

export default function App() {
  const [engines, setEngines] = useState<Engine[]>([]);
  const [engine, setEngine] = useState("lualatex");
  const [profile, setProfile] = useState<"preview" | "release">("preview");
  const [project, setProject] = useState<Project | null>(null);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [documentRoot, setDocumentRoot] = useState<string>("");
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [building, setBuilding] = useState(false);
  const [build, setBuild] = useState<BuildResult | null>(null);
  const [pdfVersion, setPdfVersion] = useState(0);
  const [bottomOpen, setBottomOpen] = useState(true);
  const [shellEscape, setShellEscape] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [gitOutput, setGitOutput] = useState("");
  const [sidebarWidth, setSidebarWidth] = useState(225);
  const [editorWidth, setEditorWidth] = useState(600);
  const [bottomHeight, setBottomHeight] = useState(220);
  const [bottomTab, setBottomTab] = useState<"build" | "terminal">("build");
  const [terminalStarted, setTerminalStarted] = useState(false);
  const logScrollRef = useRef<HTMLDivElement>(null);

  const dirty = content !== savedContent;
  const availableEngines = engines.filter((item) => item.available);
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

  const loadFile = useCallback(async (path: string, currentProject = project) => {
    if (!currentProject || !isEditable(path)) return;
    if (dirty && activeFile && path !== activeFile) {
      const proceed = window.confirm("Hay cambios sin guardar. ¿Deseas descartarlos?");
      if (!proceed) return;
    }
    try {
      const value = await invoke<string>("read_project_file", {
        projectRoot: currentProject.root,
        path,
      });
      setActiveFile(path);
      setContent(value);
      setSavedContent(value);
    } catch (error) {
      showNotice(String(error));
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

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveCurrent();
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [saveCurrent]);

  useEffect(() => {
    if (!build?.log || !logScrollRef.current) return;
    logScrollRef.current.scrollTo({ top: 0, left: 0 });
  }, [build?.log]);

  const compile = useCallback(async () => {
    if (!project || !documentRoot || building) return;
    if (dirty && !(await saveCurrent())) return;
    setBuilding(true);
    setBottomOpen(true);
    setBottomTab("build");
    try {
      const result = await invoke<BuildResult>("compile_project", {
        request: {
          projectRoot: project.root,
          document: documentRoot,
          engine,
          profile,
          shellEscape,
        },
      });
      setBuild(result);
      if (result.success) setPdfVersion((version) => version + 1);
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
  }, [building, dirty, documentRoot, engine, profile, project, saveCurrent, shellEscape]);

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
    const destination = await save({
      title: "Exportar PDF",
      defaultPath: basename(build.pdfPath),
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (!destination) return;
    await invoke("export_pdf", { source: build.pdfPath, destination });
    showNotice("PDF exportado correctamente");
  }, [build?.pdfPath, showNotice]);

  const exportProject = useCallback(async () => {
    if (!project) return;
    const destination = await save({
      title: "Exportar código fuente",
      defaultPath: `${project.name}.zip`,
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
          <div className="segmented">
            <button className={profile === "preview" ? "active" : ""} onClick={() => setProfile("preview")}>Preview</button>
            <button className={profile === "release" ? "active" : ""} onClick={() => setProfile("release")}>Release</button>
          </div>
          <button className="compile-button" onClick={compile} disabled={building || !documentRoot}>
            {building ? <LoaderCircle className="spin" size={16} /> : <Play size={16} fill="currentColor" />}
            {building ? "Compilando" : "Compilar"}
          </button>
          <div className="dropdown">
            <button className="icon-button"><Github size={18} /><ChevronDown size={13} /></button>
            <div className="dropdown-menu">
              <button onClick={() => runGit("status")}><GitPullRequest size={15} /> Estado</button>
              <button onClick={() => runGit("fetch")}><RefreshCw size={15} /> Fetch</button>
              <button onClick={() => runGit("pull")}><Download size={15} /> Pull</button>
              <button onClick={() => runGit("push")}><Upload size={15} /> Push</button>
            </div>
          </div>
          <div className="dropdown">
            <button className="icon-button"><Download size={18} /><ChevronDown size={13} /></button>
            <div className="dropdown-menu right">
              <button onClick={exportCurrentPdf} disabled={!build?.pdfPath}><FileText size={15} /> Exportar PDF</button>
              <button onClick={exportProject}><FileArchive size={15} /> Exportar fuentes ZIP</button>
            </div>
          </div>
          <button className="icon-only" title="Guardar" onClick={saveCurrent}><Save size={18} /></button>
          <button className="icon-only" title="Abrir terminal" onClick={openTerminal}><SquareTerminal size={18} /></button>
          <button className="icon-only" title="Abrir otro proyecto" onClick={chooseProject}><Folder size={18} /></button>
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
          <div className="sidebar-tabs">
            <button className="active"><Folder size={17} /></button>
            <button><BookOpen size={17} /></button>
            <button><Github size={17} /></button>
          </div>
          <div className="sidebar-title"><span>ARCHIVOS</span><button onClick={chooseProject}><Folder size={14} /></button></div>
          <FileTree key={project.root} files={project.files} activeFile={activeFile} onOpen={loadFile} />
          <label className="security-toggle" title="Permite ejecutar herramientas externas. Actívalo sólo en proyectos de confianza.">
            <input type="checkbox" checked={shellEscape} onChange={(event) => setShellEscape(event.target.checked)} />
            <span>Shell escape</span>
          </label>
        </aside>

        <div
          className="splitter splitter-vertical sidebar-splitter"
          onPointerDown={(event) => beginResize("sidebar", event)}
          role="separator"
          aria-label="Cambiar ancho del árbol de archivos"
        />

        <section className="editor-pane">
          <div className="pane-header">
            <span><FileText size={14} /> {activeFile ?? "Sin archivo"}{dirty && <b className="dirty-dot">●</b>}</span>
            <small>{engine} · {profile}</small>
          </div>
          {activeFile ? (
            <CodeMirror
              className="editor-codemirror"
              value={content}
              height="100%"
              extensions={[latex({ fileName: activeFile })]}
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
          ) : <div className="empty-pane">Selecciona un archivo editable</div>}
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
            <PdfViewer path={build.pdfPath} version={pdfVersion} />
          ) : (
            <div className="pdf-empty">
              <div className="paper-ghost"><span>TeX</span></div>
              <h2>Tu PDF aparecerá aquí</h2>
              <p>Selecciona un documento raíz y compílalo.</p>
              <button className="secondary" onClick={compile} disabled={building}><Play size={15} /> Compilar ahora</button>
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
                    {build?.diagnostics.length ? <span>{build.diagnostics.length}</span> : null}
                  </button>
                  <button
                    className={bottomTab === "terminal" ? "active" : ""}
                    onClick={openTerminal}
                  >
                    <SquareTerminal size={14} /> Terminal
                  </button>
                </div>
                <button className="bottom-close" onClick={() => setBottomOpen(false)} title="Cerrar panel"><X size={15} /></button>
              </div>
              <div
                ref={logScrollRef}
                className={`bottom-content ${bottomTab === "build" ? "" : "hidden"}`}
                tabIndex={0}
                aria-label="Registro de compilación"
              >
                {gitOutput && <pre className="git-output"><Github size={14} /> {gitOutput}</pre>}
                {build?.diagnostics.map((item, index) => (
                  <div key={`${item.message}-${index}`} className={`diagnostic ${item.severity}`}>
                    <CircleAlert size={15} /> <span>{item.message}</span>
                  </div>
                ))}
                <pre className="build-log">{build?.log ?? "Listo para compilar."}</pre>
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
        <span>{dirty ? "Cambios sin guardar" : "Guardado"}</span>
        <span className="spacer" />
        <button onClick={openTerminal}><SquareTerminal size={14} /> Terminal</button>
        <button onClick={() => setBottomOpen((value) => !value)}><PanelBottom size={14} /> Panel</button>
        <span>{project.files.filter((item) => item.kind === "file").length} archivos</span>
        <span><Box size={13} /> {availableEngines.length} motores</span>
        <button><Settings size={14} /></button>
      </footer>

      {notice && <div className="toast"><Check size={16} /> {notice}</div>}
    </main>
  );
}
