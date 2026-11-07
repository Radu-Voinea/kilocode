package ai.kilocode.client.review

import ai.kilocode.client.agentManager.worktree.PendingPrompt
import ai.kilocode.client.agentManager.worktree.PendingWorktreePrompt
import ai.kilocode.client.agentManager.worktree.WorktreeBaseUpdatePrompts
import ai.kilocode.client.agentManager.worktree.WorktreeSessionEditorKind
import ai.kilocode.client.agentManager.worktree.ensureWorktreeSessionEditorKind
import ai.kilocode.client.agentManager.worktree.normalizeWorktreePath
import ai.kilocode.client.plugin.KiloBundle
import ai.kilocode.client.vfs.KiloVfsManager
import com.intellij.openapi.Disposable
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.util.concurrency.annotations.RequiresEdt
import java.util.concurrent.atomic.AtomicLong

/**
 * A live Kilo session that can take a submitted review. Session UIs register one while they exist,
 * whether they sit in the Kilo tool window or in an Agent Manager worktree tab.
 */
interface ReviewSessionHandle {
    val sessionId: String?
    val directory: String
    val title: String?
    val readonly: Boolean

    @RequiresEdt
    fun submit(text: String, title: String)
}

/**
 * Pending review comments per diff ([ReviewScope]), the target each review goes to, and the live
 * sessions that can take one. Comments stay here, not in the diff viewer, so they survive switching
 * files in the diff and closing and reopening it; submitting sends them all as one prompt and clears
 * them. Nothing is posted anywhere else.
 */
@Service(Service.Level.PROJECT)
class KiloReviewService(private val project: Project) {
    private val ids = AtomicLong()
    private val comments = LinkedHashMap<String, MutableList<ReviewComment>>()
    private val targets = HashMap<String, ReviewTarget>()
    private val sessions = LinkedHashSet<ReviewSessionHandle>()
    private val listeners = ArrayList<(String) -> Unit>()

    @RequiresEdt
    fun comments(scope: ReviewScope): List<ReviewComment> = comments[scope.key]?.toList().orEmpty()

    @RequiresEdt
    fun comments(scope: ReviewScope, file: String): List<ReviewComment> = comments(scope).filter { it.file == file }

    @RequiresEdt
    fun add(scope: ReviewScope, file: String, side: ReviewSide, start: Int, end: Int, quote: String, text: String): ReviewComment {
        val item = ReviewComment(ids.incrementAndGet(), file, side, minOf(start, end), maxOf(start, end), quote, text.trim())
        comments.getOrPut(scope.key) { ArrayList() }.add(item)
        fire(scope.key)
        return item
    }

    @RequiresEdt
    fun update(scope: ReviewScope, id: Long, text: String) {
        val list = comments[scope.key] ?: return
        val index = list.indexOfFirst { it.id == id }
        if (index < 0) return
        list[index] = list[index].copy(text = text.trim())
        fire(scope.key)
    }

    @RequiresEdt
    fun remove(scope: ReviewScope, id: Long) {
        val list = comments[scope.key] ?: return
        if (!list.removeIf { it.id == id }) return
        if (list.isEmpty()) comments.remove(scope.key)
        fire(scope.key)
    }

    @RequiresEdt
    fun discard(scope: ReviewScope) {
        if (comments.remove(scope.key) == null) return
        fire(scope.key)
    }

    /** Calls [listener] with a scope key whenever that review's comments or target change. */
    @RequiresEdt
    fun listen(parent: Disposable, listener: (String) -> Unit) {
        listeners.add(listener)
        Disposer.register(parent) { listeners.remove(listener) }
    }

    @RequiresEdt
    fun register(handle: ReviewSessionHandle) {
        sessions.add(handle)
        fireAll()
    }

    @RequiresEdt
    fun unregister(handle: ReviewSessionHandle) {
        if (sessions.remove(handle)) fireAll()
    }

    /**
     * Where this review can go: open sessions in the diff's directory (the diff's own session first),
     * then the directory's Agent Manager tab.
     */
    @RequiresEdt
    fun targets(scope: ReviewScope): List<ReviewTarget> {
        val dir = normalizeWorktreePath(scope.directory)
        val live = sessions
            .filter { !it.readonly && normalizeWorktreePath(it.directory) == dir }
            .sortedByDescending { scope.sessionId != null && it.sessionId == scope.sessionId }
            .map { handle ->
                val title = handle.title ?: KiloBundle.message("review.target.session.untitled")
                ReviewTarget.Session(handle.sessionId, handle.directory, KiloBundle.message("review.target.session", title), handle)
            }
        val name = scope.directory.trimEnd('/', '\\').substringAfterLast('/').substringAfterLast('\\')
        return live + ReviewTarget.Worktree(scope.directory, KiloBundle.message("review.target.worktree", name))
    }

    @RequiresEdt
    fun target(scope: ReviewScope): ReviewTarget {
        val options = targets(scope)
        val picked = targets[scope.key]
        if (picked != null && options.any { same(it, picked) }) return options.first { same(it, picked) }
        return options.first()
    }

    @RequiresEdt
    fun choose(scope: ReviewScope, target: ReviewTarget) {
        targets[scope.key] = target
        fire(scope.key)
    }

    /** Sends the review as one prompt to its target and clears it. Returns false when there is nothing to send. */
    @RequiresEdt
    fun submit(scope: ReviewScope): Boolean {
        val list = comments(scope)
        if (list.isEmpty()) return false
        val text = reviewPrompt(scope, list)
        val title = KiloBundle.message("review.prompt.title")
        when (val target = target(scope)) {
            is ReviewTarget.Session -> (target.key as ReviewSessionHandle).submit(text, title)
            is ReviewTarget.Worktree -> sendToWorktree(target.path, text, title)
        }
        comments.remove(scope.key)
        fire(scope.key)
        return true
    }

    @RequiresEdt
    private fun sendToWorktree(path: String, text: String, title: String) {
        if (!project.service<WorktreeBaseUpdatePrompts>().submit(path, text, title)) {
            service<PendingWorktreePrompt>().put(path, PendingPrompt(text, injectedTitle = title))
        }
        ensureWorktreeSessionEditorKind()
        project.service<KiloVfsManager>().open(WorktreeSessionEditorKind.ID, mapOf("path" to path), true)
    }

    private fun same(a: ReviewTarget, b: ReviewTarget): Boolean = when {
        a is ReviewTarget.Session && b is ReviewTarget.Session -> a.key === b.key
        a is ReviewTarget.Worktree && b is ReviewTarget.Worktree -> normalizeWorktreePath(a.path) == normalizeWorktreePath(b.path)
        else -> false
    }

    private fun fire(key: String) {
        for (listener in listeners.toList()) listener(key)
    }

    private fun fireAll() {
        for (key in (comments.keys + targets.keys).toSet()) fire(key)
        fire("")
    }
}
