import { typstLanguageExtension } from "../editor/typst-language";

export const typstFormat = {
  id: "typst" as const,
  editingProducers: [] as const,
  readingProducers: [] as const,
  languageExtension: typstLanguageExtension(),
};
