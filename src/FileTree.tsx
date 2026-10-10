import { useMemo, useState } from "react";
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  FileCode2,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileType2,
  Folder,
  FolderOpen,
  Settings2,
} from "lucide-react";

export type ProjectFile = {
  path: string;
  name: string;
  kind: "file" | "directory";
  depth: number;
};

type Props = {
  files: ProjectFile[];
  activeFile: string | null;
  onOpen: (path: string) => void;
};

function ancestors(path: string) {
  const parts = path.split("/");
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
}

function FileIcon({ name }: { name: string }) {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(extension)) {
    return <FileImage className="tree-file-icon image" size={16} aria-label="Imagen" />;
  }
  if (["csv", "xls", "xlsx"].includes(extension)) {
    return <FileSpreadsheet className="tree-file-icon table" size={16} aria-label="Hoja de cálculo" />;
  }
  if (extension === "bib") {
    return <BookOpen className="tree-file-icon bibliography" size={16} aria-label="Bibliografía" />;
  }
  if (extension === "pdf") {
    return <FileType2 className="tree-file-icon pdf" size={16} aria-label="PDF" />;
  }
  if (["cls", "sty", "bst", "py", "r", "js", "ts"].includes(extension)) {
    return <FileCode2 className="tree-file-icon code" size={16} aria-label="Código" />;
  }
  if (["toml", "yaml", "yml", "json", "ini"].includes(extension)) {
    return <Settings2 className="tree-file-icon config" size={16} aria-label="Configuración" />;
  }
  return <FileText className={`tree-file-icon ${extension === "tex" ? "tex" : "text"}`} size={16} aria-label="Documento" />;
}

export default function FileTree({ files, activeFile, onOpen }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
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

  return (
    <div className="file-tree" role="tree" aria-label="Archivos del proyecto">
      {visibleFiles.map((item) => {
        const isFolder = item.kind === "directory";
        const isExpanded = expanded.has(item.path);
        return (
          <button
            key={item.path}
            className={`file-row ${activeFile === item.path ? "active" : ""}`}
            style={{ paddingLeft: 10 + item.depth * 15 }}
            onClick={() => isFolder ? toggleFolder(item.path) : onOpen(item.path)}
            title={item.path}
            role="treeitem"
            aria-expanded={isFolder ? isExpanded : undefined}
          >
            <span className="tree-chevron">
              {isFolder ? (isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />) : null}
            </span>
            {isFolder
              ? (isExpanded ? <FolderOpen size={14} /> : <Folder size={14} />)
              : <FileIcon name={item.name} />}
            <span>{item.name}</span>
          </button>
        );
      })}
    </div>
  );
}
