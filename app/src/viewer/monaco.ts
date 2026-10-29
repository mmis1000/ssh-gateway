// only what a read only viewer needs: the editor, the syntax colors of every language (each one
// loads when first used) and a few features. The language services would add several MB
import * as monaco from 'monaco-editor/editor/editor.api'
import 'monaco-editor/languages/definitions/register.all'
import 'monaco-editor/features/bracketMatching/register'
import 'monaco-editor/features/clipboard/register'
import 'monaco-editor/features/codicon/register'
import 'monaco-editor/features/contextmenu/register'
import 'monaco-editor/features/find/register'
import 'monaco-editor/features/folding/register'
import 'monaco-editor/features/gotoLine/register'
import 'monaco-editor/features/lineSelection/register'
import 'monaco-editor/features/readOnlyMessage/register'
import 'monaco-editor/features/stickyScroll/register'
import 'monaco-editor/features/wordHighlighter/register'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'

self.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
}

export { monaco }
