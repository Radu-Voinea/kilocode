package ai.kilocode.client.session.ui.prompt

import ai.kilocode.client.session.model.PromptAttachmentExtractor
import com.intellij.ide.dnd.FileCopyPasteUtil
import com.intellij.openapi.actionSystem.DataContext
import com.intellij.openapi.editor.Caret
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.actionSystem.EditorActionHandler
import com.intellij.openapi.editor.actions.PasteAction
import com.intellij.openapi.ide.CopyPasteManager
import java.awt.datatransfer.DataFlavor
import java.awt.datatransfer.Transferable

/**
 * Runs first for `EditorPaste` and claims file, image and large-text pastes in a Kilo prompt editor.
 *
 * The [PromptAttachmentPasteProvider] and [PromptTextPasteProvider] `customPasteProvider`s are not
 * enough on their own: the platform's `PasteHandler` asks custom providers only when it finds a PSI
 * file for the editor, and since 2026.3 it looks that up through the editor context
 * (`EditorContextManager`), which finds none for an embedded text field. The paste then falls
 * through to a plain text paste and a screenshot or copied file is silently dropped. Handling the
 * paste here does not depend on that lookup; every other editor goes straight to [original].
 */
internal class PromptPasteActionHandler(private val original: EditorActionHandler) : EditorActionHandler() {
    override fun isEnabledForCaret(editor: Editor, caret: Caret, dataContext: DataContext?): Boolean =
        original.isEnabled(editor, caret, dataContext)

    override fun doExecute(editor: Editor, caret: Caret?, dataContext: DataContext?) {
        val attach = editor.getUserData(PROMPT_ATTACHMENT_PASTE_HANDLER_KEY)
        val text = editor.getUserData(PROMPT_TEXT_PASTE_HANDLER_KEY)
        if (attach != null || text != null) {
            val item = dataContext?.getData(PasteAction.TRANSFERABLE_PROVIDER)?.produce()
                ?: CopyPasteManager.getInstance().contents
            LOG.info("prompt paste flavors=${item?.transferDataFlavors?.joinToString { it.mimeType }}")
            if (item != null && attach != null && attachable(item)) {
                attach.paste(item)
                return
            }
            if (attach != null) {
                val native = NativeClipboard.attachable(ideEmpty = item == null)
                if (native != null) {
                    attach.paste(native)
                    return
                }
            }
            val value = item?.let(::collapsibleText)
            if (value != null && text != null && editor.document.isWritable) {
                text.paste(value)
                return
            }
        }
        original.execute(editor, caret, dataContext)
    }
}

private val LOG = com.intellij.openapi.diagnostic.Logger.getInstance(PromptPasteActionHandler::class.java)

/** Whether a paste of [item] becomes prompt attachments: a file list, or an image with no files. */
internal fun attachable(item: Transferable): Boolean =
    FileCopyPasteUtil.isFileListFlavorAvailable(item.transferDataFlavors) || PromptAttachmentExtractor.hasClipboardImage(item)

/** The text of [item] when it is a plain-text paste large enough to collapse, else null. */
internal fun collapsibleText(item: Transferable): String? {
    if (!item.isDataFlavorSupported(DataFlavor.stringFlavor)) return null
    if (attachable(item)) return null
    val value = runCatching { item.getTransferData(DataFlavor.stringFlavor) as? String }.getOrNull() ?: return null
    return value.takeIf(::collapsible)
}
