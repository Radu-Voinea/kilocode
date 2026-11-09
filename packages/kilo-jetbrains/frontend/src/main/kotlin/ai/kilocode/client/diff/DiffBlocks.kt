package ai.kilocode.client.diff

import ai.kilocode.client.plugin.KiloBundle
import ai.kilocode.rpc.dto.DiffFileDto
import com.intellij.diff.DiffContentFactory
import com.intellij.diff.contents.DocumentContent
import com.intellij.diff.requests.DiffRequest
import com.intellij.diff.requests.SimpleDiffRequest
import com.intellij.diff.util.DiffUserDataKeys
import com.intellij.diff.util.DiffUserDataKeysEx
import com.intellij.openapi.fileTypes.FileTypeManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.vcs.FileStatus
import java.util.function.IntUnaryOperator

internal fun diffRequest(
    project: Project,
    dto: DiffFileDto,
    branch: String? = null,
    labels: Pair<String, String> = KiloBundle.message("diff.editor.side.base") to KiloBundle.message("diff.editor.side.current"),
    context: com.intellij.openapi.vfs.VirtualFile? = null,
): DiffRequest {
    val sides = DiffPatchReconstruct.sides(dto)
    val type = FileTypeManager.getInstance().getFileTypeByFileName(dto.file)
    val factory = DiffContentFactory.getInstance()
    val status = fileStatus(dto)
    val patch = dto.patch?.takeIf { it.isNotBlank() }
    val fallback = patch ?: KiloBundle.message("diff.editor.patch.unavailable")
    val full = dto.before != null && dto.after != null
    val left = when {
        full -> text(factory, project, dto.before.orEmpty(), type, context)
        DiffPatchReconstruct.added(dto.patch) -> factory.createEmpty()
        sides.renderable -> text(factory, project, sides.before, type, context).numbered(sides.leftLines)
        status == FileStatus.DELETED -> factory.create(project, fallback, type)
        else -> factory.createEmpty()
    }
    val right = when {
        full -> text(factory, project, dto.after.orEmpty(), type, context)
        DiffPatchReconstruct.deleted(dto.patch) -> factory.createEmpty()
        sides.renderable -> text(factory, project, sides.after, type, context).numbered(sides.rightLines)
        status == FileStatus.DELETED -> factory.createEmpty()
        else -> factory.create(project, fallback, type)
    }
    return SimpleDiffRequest(diffTitle(dto.file, branch), left, right, labels.first, labels.second).also {
        it.putUserData(DiffUserDataKeys.FORCE_READ_ONLY, true)
    }
}

/**
 * Diff text tied to the real file when it exists, so the IDE highlights it with the project's context and
 * resolves its symbols: Ctrl+click (and Kilo's Shift+click) then go to definitions as in a VCS diff.
 */
private fun text(
    factory: DiffContentFactory,
    project: Project,
    text: String,
    type: com.intellij.openapi.fileTypes.FileType,
    context: com.intellij.openapi.vfs.VirtualFile?,
): DocumentContent =
    if (context != null && context.isValid && !context.isDirectory) factory.create(project, text, context)
    else factory.create(project, text, type)

internal fun diffTitle(file: String, branch: String?): String {
    val name = branch.takeIf { !it.isNullOrBlank() } ?: return file
    return KiloBundle.message("diff.editor.file.title", file, name)
}

// The hunk-fallback content is a concatenation of hunk bodies, so its own document lines restart at 1.
// Remap each document line to its real source-file line (0-based; the platform adds 1) so the gutter
// matches the file instead of showing 1..N. Lines with no mapping return -1 and the platform hides them.
private fun DocumentContent.numbered(lines: List<Int>): DocumentContent = apply {
    if (lines.isNotEmpty()) putUserData(DiffUserDataKeysEx.LINE_NUMBER_CONVERTOR, IntUnaryOperator { lines.getOrElse(it) { -1 } })
}
