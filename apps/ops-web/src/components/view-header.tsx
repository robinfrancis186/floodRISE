import type { ReactNode } from "react";

export function ViewHeader({ title, description, actions }: { title: string; description: string; actions?: ReactNode }) {
  return <header className="view-header"><div><h2>{title}</h2><p>{description}</p></div>{actions && <div className="view-header-actions">{actions}</div>}</header>;
}
