import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Folder, FolderOpen } from "lucide-react";

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

function fileType(name: string) {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  const types: Record<string, { label: string; tone: string }> = {
    tex: { label: "TeX", tone: "tex" },
    bib: { label: "BIB", tone: "bib" },
    cls: { label: "CLS", tone: "style" },
    sty: { label: "STY", tone: "style" },
    bst: { label: "BST", tone: "style" },
    pdf: { label: "PDF", tone: "pdf" },
    png: { label: "PNG", tone: "image" },
    jpg: { label: "JPG", tone: "image" },
    jpeg: { label: "JPG", tone: "image" },
    gif: { label: "GIF", tone: "image" },
    webp: { label: "WEBP", tone: "image" },
    svg: { label: "SVG", tone: "image" },
    md: { label: "MD", tone: "text" },
    txt: { label: "TXT", tone: "text" },
    toml: { label: "CFG", tone: "config" },
  };
  return types[extension] ?? { label: extension.slice(0, 4).toUpperCase() || "FILE", tone: "other" };
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
        const type = fileType(item.name);
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
              : <span className={`file-type-badge ${type.tone}`}>{type.label}</span>}
            <span>{item.name}</span>
          </button>
        );
      })}
    </div>
  );
}
