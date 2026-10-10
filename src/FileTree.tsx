import { useCallback, useEffect, useMemo, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  BookOpen, ChevronDown, ChevronRight, Download, FileCheck2, FileCode2, FileImage,
  FilePlus2, FileSpreadsheet, FileText, FileType2, Folder, FolderOpen, FolderPlus,
  Pencil, Settings2, Trash2, Upload,
} from "lucide-react";

export type ProjectFile = {
  path: string;
  name: string;
  kind: "file" | "directory";
  depth: number;
};

export type TreeAction = "open" | "rename" | "download" | "set-main" | "delete" | "new-file" | "new-folder" | "upload";

type Props = {
  files: ProjectFile[];
  activeFile: string | null;
  documentRoot: string;
  onOpen: (path: string) => void;
  onAction: (action: TreeAction, item: ProjectFile | null, directory: string) => void;
  onImportFiles: (sources: string[], directory: string) => void;
};

type ContextMenu = { x: number; y: number; item: ProjectFile | null };

function ancestors(path: string) {
  const parts = path.split("/");
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
}

function parentDirectory(path: string) {
  const parts = path.split("/");
  parts.pop();
  return parts.join("/");
}

function FileIcon({ name }: { name: string }) {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(extension)) {
    return <FileImage className="tree-file-icon image" size={16} aria-label="Imagen" />;
  }
  if (["csv", "xls", "xlsx"].includes(extension)) {
    return <FileSpreadsheet className="tree-file-icon table" size={16} aria-label="Hoja de cálculo" />;
  }
  if (extension === "bib") return <BookOpen className="tree-file-icon bibliography" size={16} aria-label="Bibliografía" />;
  if (extension === "pdf") return <FileType2 className="tree-file-icon pdf" size={16} aria-label="PDF" />;
  if (["cls", "sty", "bst", "py", "r", "js", "ts"].includes(extension)) {
    return <FileCode2 className="tree-file-icon code" size={16} aria-label="Código" />;
  }
  if (["toml", "yaml", "yml", "json", "ini"].includes(extension)) {
    return <Settings2 className="tree-file-icon config" size={16} aria-label="Configuración" />;
  }
  return <FileText className={`tree-file-icon ${extension === "tex" ? "tex" : "text"}`} size={16} aria-label="Documento" />;
}

export default function FileTree({ files, activeFile, documentRoot, onOpen, onAction, onImportFiles }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [menu, setMenu] = useState<ContextMenu | null>(null);
  const [dragDirectory, setDragDirectory] = useState<string | null>(null);
  const visibleFiles = useMemo(
    () => files.filter((item) => ancestors(item.path).every((parent) => expanded.has(parent))),
    [expanded, files],
  );

  const toggleFolder = (path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const directoryFor = useCallback((item: ProjectFile | null) => {
    if (!item) return "";
    return item.kind === "directory" ? item.path : parentDirectory(item.path);
  }, []);

  const showMenu = (event: React.MouseEvent, item: ProjectFile | null) => {
    event.preventDefault();
    event.stopPropagation();
    const width = 245;
    const height = item ? 350 : 145;
    setMenu({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8)),
      item,
    });
  };

  const runAction = (action: TreeAction) => {
    if (!menu) return;
    const { item } = menu;
    setMenu(null);
    onAction(action, item, directoryFor(item));
  };

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", close);
    };
  }, [menu]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const targetAt = async (x: number, y: number) => {
      const scale = await getCurrentWindow().scaleFactor();
      const point = document.elementFromPoint(x / scale, y / scale);
      const tree = point?.closest<HTMLElement>(".file-tree");
      if (!tree) return null;
      const row = point?.closest<HTMLElement>("[data-tree-path]");
      if (!row || !tree.contains(row)) return "";
      return row.dataset.treeKind === "directory"
        ? (row.dataset.treePath ?? "")
        : parentDirectory(row.dataset.treePath ?? "");
    };

    void getCurrentWindow().onDragDropEvent(async ({ payload }) => {
      if (payload.type === "leave") {
        setDragDirectory(null);
        return;
      }
      const directory = await targetAt(payload.position.x, payload.position.y);
      setDragDirectory(directory);
      if (payload.type === "drop" && directory !== null) {
        if (directory) setExpanded((current) => new Set(current).add(directory));
        onImportFiles(payload.paths, directory);
        setDragDirectory(null);
      }
    }).then((stop) => { unlisten = stop; });
    return () => unlisten?.();
  }, [onImportFiles]);

  return (
    <div
      className={`file-tree ${dragDirectory === "" ? "drag-root" : ""}`}
      role="tree"
      aria-label="Archivos del proyecto"
      onContextMenu={(event) => showMenu(event, null)}
    >
      {visibleFiles.map((item) => {
        const isFolder = item.kind === "directory";
        const isExpanded = expanded.has(item.path);
        const itemDirectory = directoryFor(item);
        return (
          <button
            key={item.path}
            className={`file-row ${activeFile === item.path ? "active" : ""} ${dragDirectory !== null && dragDirectory === itemDirectory && isFolder ? "drag-target" : ""}`}
            style={{ paddingLeft: 10 + item.depth * 15 }}
            onClick={() => isFolder ? toggleFolder(item.path) : onOpen(item.path)}
            onContextMenu={(event) => showMenu(event, item)}
            title={item.path}
            role="treeitem"
            aria-expanded={isFolder ? isExpanded : undefined}
            data-tree-path={item.path}
            data-tree-kind={item.kind}
          >
            <span className="tree-chevron">
              {isFolder ? (isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />) : null}
            </span>
            {isFolder ? (isExpanded ? <FolderOpen size={14} /> : <Folder size={14} />) : <FileIcon name={item.name} />}
            <span>{item.name}</span>
          </button>
        );
      })}

      {menu && (
        <div className="tree-context-menu" style={{ left: menu.x, top: menu.y }} role="menu" onPointerDown={(event) => event.stopPropagation()}>
          {menu.item?.kind === "file" && <button onClick={() => runAction("open")}><FileText size={16} /> Abrir</button>}
          {menu.item && <button onClick={() => runAction("rename")}><Pencil size={16} /> Renombrar</button>}
          {menu.item?.kind === "file" && <button onClick={() => runAction("download")}><Download size={16} /> Descargar</button>}
          {menu.item?.kind === "file" && menu.item.name.toLowerCase().endsWith(".tex") && (
            <button onClick={() => runAction("set-main")} disabled={documentRoot === menu.item.path}>
              <FileCheck2 size={16} /> {documentRoot === menu.item.path ? "Documento principal" : "Establecer como principal"}
            </button>
          )}
          {menu.item && <div className="context-separator" />}
          {menu.item && <button className="danger" onClick={() => runAction("delete")}><Trash2 size={16} /> Eliminar</button>}
          {menu.item && <div className="context-separator" />}
          <button onClick={() => runAction("new-file")}><FilePlus2 size={16} /> Nuevo archivo</button>
          <button onClick={() => runAction("new-folder")}><FolderPlus size={16} /> Nueva carpeta</button>
          <button onClick={() => runAction("upload")}><Upload size={16} /> Importar archivos</button>
        </div>
      )}
    </div>
  );
}
