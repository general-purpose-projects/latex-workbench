import { useCallback, useEffect, useMemo, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { latex } from "codemirror-lang-latex";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  BookOpen,
  Box,
  Check,
  ChevronDown,
  CircleAlert,
  Code2,
  Download,
  File,
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
  Upload,
  X,
} from "lucide-react";

type Engine = {
  id: string;
  label: string;
  available: boolean;
  path?: string;
  version?: string;
};

type ProjectFile = {
  path: string;
  name: string;
  kind: "file" | "directory";
  depth: number;
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

  const dirty = content !== savedContent;
  const availableEngines = engines.filter((item) => item.available);
  const pdfUrl = useMemo(
    () => (build?.pdfPath ? `${convertFileSrc(build.pdfPath)}?v=${pdfVersion}` : null),
    [build?.pdfPath, pdfVersion],
  );

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

  const compile = useCallback(async () => {
    if (!project || !documentRoot || building) return;
    if (dirty && !(await saveCurrent())) return;
    setBuilding(true);
    setBottomOpen(true);
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
    } catch (error) {
      setGitOutput(String(error));
      setBottomOpen(true);
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
          <button className="icon-only" title="Abrir otro proyecto" onClick={chooseProject}><Folder size={18} /></button>
        </div>
      </header>

      <section className={`workspace ${bottomOpen ? "with-bottom" : ""}`}>
        <aside className="sidebar">
          <div className="sidebar-tabs">
            <button className="active"><Folder size={17} /></button>
            <button><BookOpen size={17} /></button>
            <button><Github size={17} /></button>
          </div>
          <div className="sidebar-title"><span>ARCHIVOS</span><button onClick={chooseProject}><Folder size={14} /></button></div>
          <div className="file-tree">
            {project.files.map((item) => (
              <button
                key={item.path}
                className={`file-row ${activeFile === item.path ? "active" : ""}`}
                style={{ paddingLeft: 12 + item.depth * 14 }}
                onClick={() => item.kind === "file" && loadFile(item.path)}
                title={item.path}
              >
                {item.kind === "directory" ? <Folder size={14} /> : <File size={14} />}
                <span>{item.name}</span>
              </button>
            ))}
          </div>
          <label className="security-toggle" title="Permite ejecutar herramientas externas. Actívalo sólo en proyectos de confianza.">
            <input type="checkbox" checked={shellEscape} onChange={(event) => setShellEscape(event.target.checked)} />
            <span>Shell escape</span>
          </label>
        </aside>

        <section className="editor-pane">
          <div className="pane-header">
            <span><FileText size={14} /> {activeFile ?? "Sin archivo"}{dirty && <b className="dirty-dot">●</b>}</span>
            <small>{engine} · {profile}</small>
          </div>
          {activeFile ? (
            <CodeMirror
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
          {pdfUrl ? (
            <iframe className="pdf-frame" src={pdfUrl} title="Vista previa PDF" />
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
          <section className="bottom-panel">
            <div className="bottom-header">
              <div>
                <strong>Compilación</strong>
                {build?.diagnostics.length ? <span>{build.diagnostics.length} diagnósticos</span> : null}
              </div>
              <button onClick={() => setBottomOpen(false)}><X size={15} /></button>
            </div>
            <div className="bottom-content">
              {gitOutput && <pre className="git-output"><Github size={14} /> {gitOutput}</pre>}
              {build?.diagnostics.map((item, index) => (
                <div key={`${item.message}-${index}`} className={`diagnostic ${item.severity}`}>
                  <CircleAlert size={15} /> <span>{item.message}</span>
                </div>
              ))}
              <pre className="build-log">{build?.log ?? "Listo para compilar."}</pre>
            </div>
          </section>
        )}
      </section>

      <footer className="statusbar">
        <span>{dirty ? "Cambios sin guardar" : "Guardado"}</span>
        <span className="spacer" />
        <button onClick={() => setBottomOpen((value) => !value)}><PanelBottom size={14} /> Panel</button>
        <span>{project.files.filter((item) => item.kind === "file").length} archivos</span>
        <span><Box size={13} /> {availableEngines.length} motores</span>
        <button><Settings size={14} /></button>
      </footer>

      {notice && <div className="toast"><Check size={16} /> {notice}</div>}
    </main>
  );
}
