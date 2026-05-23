import { headingsProducer } from "../editor/decorations/headings";
import { inlineProducer } from "../editor/decorations/inline";
import { listsProducer } from "../editor/decorations/lists";
import { linksProducer } from "../editor/decorations/links";
import { imagesProducer } from "../editor/decorations/images";
import { blockquotesProducer } from "../editor/decorations/blockquotes";
import { tablesProducer } from "../editor/decorations/tables";
import { codeblocksProducer } from "../editor/decorations/codeblocks";
import { frontmatterProducer } from "../editor/decorations/frontmatter";
import { footnotesProducer } from "../editor/decorations/footnotes";
import { readingWidgetsProducer } from "../editor/decorations/reading-widgets";
import { mathProducer } from "../editor/decorations/math";
import { mermaidProducer } from "../editor/decorations/mermaid";
import { graphvizProducer } from "../editor/decorations/graphviz";

export const markdownFormat = {
  id: "markdown" as const,
  editingProducers: [
    headingsProducer,
    inlineProducer,
    listsProducer,
    linksProducer,
    imagesProducer,
    blockquotesProducer,
    tablesProducer,
    codeblocksProducer,
    frontmatterProducer,
    footnotesProducer,
  ],
  readingProducers: [
    headingsProducer,
    inlineProducer,
    listsProducer,
    linksProducer,
    imagesProducer,
    blockquotesProducer,
    tablesProducer,
    codeblocksProducer,
    frontmatterProducer,
    footnotesProducer,
    readingWidgetsProducer,
    mathProducer,
    mermaidProducer,
    graphvizProducer,
  ],
};
