"use client";

import dynamic from "next/dynamic";
import { TemplateEditorSkeleton } from "./editor-skeleton";

// The editor is ~8.7k lines of client code. Load it on demand behind a skeleton
// so the route paints at once instead of waiting on the whole editor bundle. It
// loads its own data, so server rendering would add nothing.
const WordTemplateEditor = dynamic(() => import("./TemplateEditor"), {
  ssr: false,
  loading: () => <TemplateEditorSkeleton />,
});

export default WordTemplateEditor;
