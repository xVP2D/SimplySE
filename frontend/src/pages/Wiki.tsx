import { useState } from "react";
import { useTranslation } from "../i18n";
import { WIKI_CONTENT, type WikiBlock } from "../wiki/content";

function Block({ block }: { block: WikiBlock }) {
  switch (block.type) {
    case "p":
      return <p style={{ margin: 0, lineHeight: 1.6 }}>{block.text}</p>;
    case "h3":
      return (
        <h4 style={{ margin: "8.4px 0 0", fontSize: 14 }}>{block.text}</h4>
      );
    case "ul":
      return (
        <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 5.6, lineHeight: 1.6 }}>
          {block.items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      );
    case "dl":
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 11.2 }}>
          {block.items.map(([term, def], i) => (
            <div key={i}>
              <div style={{ fontFamily: "ui-monospace,Menlo,monospace", fontSize: 13, color: "var(--color-accent)" }}>{term}</div>
              <div style={{ fontSize: 13, lineHeight: 1.6, color: "var(--color-neutral-300)" }}>{def}</div>
            </div>
          ))}
        </div>
      );
    case "code":
      return (
        <pre
          style={{
            margin: 0,
            fontFamily: "ui-monospace,Menlo,monospace",
            fontSize: 12,
            background: "var(--color-neutral-900, rgba(0,0,0,0.15))",
            padding: 11.2,
            borderRadius: 6,
            overflowX: "auto",
          }}
        >
          {block.text}
        </pre>
      );
    default:
      return null;
  }
}

export function Wiki() {
  const { locale } = useTranslation();
  const sections = WIKI_CONTENT[locale];
  const [activeId, setActiveId] = useState(sections[0].id);
  const active = sections.find((s) => s.id === activeId) ?? sections[0];

  return (
    <div style={{ display: "grid", gridTemplateColumns: "200px minmax(0,1fr)", gap: 16.8, alignItems: "start" }}>
      <nav
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 2.8,
          padding: 8.4,
          borderRadius: 8,
          background: "var(--color-surface)",
          boxShadow: "var(--shadow-sm)",
          position: "sticky",
          top: 0,
        }}
      >
        {sections.map((s) => (
          <button
            key={s.id}
            type="button"
            className={"btn " + (s.id === activeId ? "btn-primary" : "btn-ghost")}
            style={{ justifyContent: "flex-start", textAlign: "left" }}
            onClick={() => setActiveId(s.id)}
          >
            {s.title}
          </button>
        ))}
      </nav>

      <section
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 11.2,
          padding: 16.8,
          borderRadius: 8,
          background: "var(--color-surface)",
          boxShadow: "var(--shadow-sm)",
        }}
      >
        <h3 style={{ margin: 0 }}>{active.title}</h3>
        {active.blocks.map((block, i) => (
          <Block key={i} block={block} />
        ))}
      </section>
    </div>
  );
}
