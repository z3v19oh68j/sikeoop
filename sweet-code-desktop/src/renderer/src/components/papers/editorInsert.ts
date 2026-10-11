import { monaco } from "../../monaco";

/**
 * Puts text at the cursor of the editor that shows `file`, replacing what is selected there.
 * False when the file isn't open as source right now (closed, or shown as a rendered preview).
 */
export function insertIntoEditor(file: string, text: string): boolean {
  const uri = monaco.Uri.parse(file).toString();
  const editor = monaco.editor.getEditors().find((e) => e.getModel()?.uri.toString() === uri);
  const selection = editor?.getSelection();
  if (!editor || !selection) return false;
  editor.pushUndoStop();
  editor.executeEdits("sikeoop.cite", [{ range: selection, text, forceMoveMarkers: true }]);
  editor.pushUndoStop();
  return true;
}
