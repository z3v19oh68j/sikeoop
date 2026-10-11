import { useState } from "react";
import type { FileNode } from "@shared/types";
import { Icon, fileIconName } from "./Icon";

interface Props {
  nodes: FileNode[];
  activePath?: string;
  onOpen(path: string): void;
}

export function FileTree({ nodes, activePath, onOpen }: Props) {
  return (
    <div className="tree" role="tree">
      {nodes.map((n) => (
        <TreeNode key={n.path} node={n} depth={0} activePath={activePath} onOpen={onOpen} />
      ))}
    </div>
  );
}

function TreeNode({ node, depth, activePath, onOpen }: { node: FileNode; depth: number } & Omit<Props, "nodes">) {
  const [open, setOpen] = useState(depth === 0 && node.kind === "dir" && (node.children?.length ?? 0) < 12);
  const isDir = node.kind === "dir";
  return (
    <>
      <button
        type="button"
        role="treeitem"
        aria-expanded={isDir ? open : undefined}
        className={"tree-row" + (node.path === activePath ? " active" : "")}
        style={{ paddingLeft: 6 + depth * 12 }}
        onClick={() => (isDir ? setOpen(!open) : onOpen(node.path))}
        title={node.path}
      >
        <span className="chev">{isDir && <Icon name={open ? "chevron-down" : "chevron-right"} />}</span>
        <Icon name={isDir ? (open ? "ft-folder-open" : "ft-folder") : fileIconName(node.name)} className="ft" />
        <span className="name">{node.name}</span>
      </button>
      {isDir && open &&
        node.children?.map((c) => (
          <TreeNode key={c.path} node={c} depth={depth + 1} activePath={activePath} onOpen={onOpen} />
        ))}
    </>
  );
}
