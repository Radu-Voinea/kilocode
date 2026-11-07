package ai.kilocode.client.review

/**
 * What a review is about: one Kilo diff (a session's changes, a worktree's uncommitted changes, or a
 * branch against its base) in one directory. Comments collect per scope until the user submits them.
 */
data class ReviewScope(
    val directory: String,
    val source: String,
    val sessionId: String? = null,
    val branch: String? = null,
    val title: String = "",
) {
    /** Identity of the review: the same diff reopened keeps its pending comments. */
    val key: String get() = listOf(source, directory, sessionId.orEmpty()).joinToString("|")

    internal companion object {
        fun from(params: Map<String, String>): ReviewScope? {
            val dir = params["directory"]?.takeIf { it.isNotBlank() } ?: return null
            return ReviewScope(
                directory = dir,
                source = params["source"]?.takeIf { it.isNotBlank() } ?: "session",
                sessionId = params["sessionId"]?.takeIf { it.isNotBlank() },
                branch = params["branch"]?.takeIf { it.isNotBlank() },
                title = params["title"].orEmpty(),
            )
        }
    }
}

/** Which side of the diff a comment is on: the old text (base) or the new text (changes). */
enum class ReviewSide { OLD, NEW }

/**
 * One review comment. [start] and [end] are 1-based file line numbers on [side] (as the diff gutter
 * shows them); [quote] is the code on those lines when the comment was written, so the agent can find
 * the spot even after the file moves on.
 */
data class ReviewComment(
    val id: Long,
    val file: String,
    val side: ReviewSide,
    val start: Int,
    val end: Int,
    val quote: String,
    val text: String,
)

/** Where a submitted review goes. */
sealed interface ReviewTarget {
    val label: String

    /** A Kilo session open somewhere in this project. */
    data class Session(val id: String?, val directory: String, override val label: String, val key: Any) : ReviewTarget

    /** The Agent Manager tab of a worktree; the prompt goes to the session it shows. */
    data class Worktree(val path: String, override val label: String) : ReviewTarget
}

/** Line label as the comment card and prompt show it. */
fun reviewLines(start: Int, end: Int): String = if (start == end) "Line $start" else "Lines $start–$end"

/**
 * The prompt a submitted review sends: every comment with its file, side, line range and quoted code,
 * grouped by file in the order the user wrote them.
 */
fun reviewPrompt(scope: ReviewScope, comments: List<ReviewComment>): String = buildString {
    append("I reviewed ")
    append(describe(scope))
    append(" and left ")
    append(if (comments.size == 1) "1 comment" else "${comments.size} comments")
    append(". Address each comment: change the code where a comment asks for a change, and answer it where it asks a question. ")
    append("Line numbers are those of the diff when I wrote the comment; use the quoted code to find the spot if the file has changed since.\n")
    val groups = comments.groupBy { it.file }
    var n = 0
    for ((file, items) in groups) {
        append("\n## `").append(file).append("`\n")
        for (item in items.sortedWith(compareBy({ it.side }, { it.start }))) {
            n += 1
            append("\n### Comment ").append(n).append(" — ").append(reviewLines(item.start, item.end))
            if (item.side == ReviewSide.OLD) append(" (removed code, old version)")
            append("\n\n")
            if (item.quote.isNotBlank()) {
                val fence = fence(item.quote)
                append(fence).append(language(file)).append('\n')
                append(item.quote.trimEnd('\n')).append('\n')
                append(fence).append("\n\n")
            }
            append(item.text.trim()).append('\n')
        }
    }
}

private fun describe(scope: ReviewScope): String = when (scope.source) {
    "branch" -> buildString {
        append("the changes on ")
        append(scope.branch?.let { "branch `$it`" } ?: "this branch")
        append(" against its base branch in `").append(scope.directory).append('`')
    }
    "local" -> "the uncommitted changes in `${scope.directory}`"
    else -> "the changes you made in this session (in `${scope.directory}`)"
}

// A quote that itself holds a ``` fence needs a longer fence around it.
private fun fence(text: String): String {
    var longest = 0
    Regex("`{3,}").findAll(text).forEach { longest = maxOf(longest, it.value.length) }
    return "`".repeat(maxOf(3, longest + 1))
}

private fun language(file: String): String {
    val ext = file.substringAfterLast('/').substringAfterLast('.', "").lowercase()
    return when (ext) {
        "kt", "kts" -> "kotlin"
        "ts", "tsx" -> "typescript"
        "js", "jsx", "mjs", "cjs" -> "javascript"
        "py" -> "python"
        "rs" -> "rust"
        "rb" -> "ruby"
        "md" -> "markdown"
        "yml" -> "yaml"
        "sh" -> "bash"
        else -> ext
    }
}
