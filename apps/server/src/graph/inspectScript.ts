/**
 * Graph inspector run by the pipeline agent through the venv python. Prints one
 * JSON line; reads graphify-out/graph.json relative to cwd and tolerates a
 * missing or corrupt file. No absolute paths — the subject root is the cwd.
 */
export const INSPECT_SCRIPT = `import json
import os


def as_list(value):
    return value if isinstance(value, list) else []


def endpoint(value):
    if isinstance(value, (str, int)):
        return str(value)
    if isinstance(value, dict):
        return endpoint(value.get("id"))
    return ""


def main():
    data = {}
    try:
        with open(os.path.join("graphify-out", "graph.json"), "r", encoding="utf-8") as f:
            loaded = json.load(f)
        if isinstance(loaded, dict):
            data = loaded
    except Exception:
        data = {}
    nodes = [n for n in as_list(data.get("nodes")) if isinstance(n, dict)]
    edges = as_list(data.get("edges")) or as_list(data.get("links"))
    edges = [e for e in edges if isinstance(e, dict)]
    entity_types = {}
    for node in nodes:
        kind = node.get("entity_type") or node.get("file_type") or node.get("type") or "(missing)"
        entity_types[str(kind)] = entity_types.get(str(kind), 0) + 1
    relations = {}
    connected = set()
    for edge in edges:
        relation = edge.get("relation") or edge.get("type") or "(missing)"
        relations[str(relation)] = relations.get(str(relation), 0) + 1
        for end in (endpoint(edge.get("source")), endpoint(edge.get("target"))):
            if end:
                connected.add(end)
    orphans = 0
    for node in nodes:
        node_id = endpoint(node)
        if node_id and node_id not in connected:
            orphans += 1
    print(json.dumps({
        "nodes": len(nodes),
        "edges": len(edges),
        "orphans": orphans,
        "entity_types": entity_types,
        "relations": relations,
    }))


if __name__ == "__main__":
    main()
`;
