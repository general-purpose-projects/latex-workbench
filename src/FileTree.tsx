import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, File, Folder, FolderOpen } from "lucide-react";

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
              : <File size={14} />}
            <span>{item.name}</span>
          </button>
        );
      })}
    </div>
  );
}
