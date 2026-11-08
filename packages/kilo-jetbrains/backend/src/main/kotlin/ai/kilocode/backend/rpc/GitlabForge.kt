package ai.kilocode.backend.rpc

import ai.kilocode.rpc.dto.GhChecks
import ai.kilocode.rpc.dto.GhChecksDto
import ai.kilocode.rpc.dto.GhMerge
import ai.kilocode.rpc.dto.GhState
import ai.kilocode.rpc.dto.WorktreePrDto
import com.intellij.ide.util.PropertiesComponent
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import java.net.URI
import java.nio.file.Path

/** The code host whose CLI answers pull/merge request questions for one repository. */
internal enum class Forge { GITHUB, GITLAB }

/**
 * The integration toggles, read from the same application properties the frontend settings page writes.
 * The GitHub key mirrors `KiloPluginSettings.getGithub`.
 */
internal object ForgeSettings {
    const val GITHUB_KEY = "kilo.integrations.github"
    const val GITLAB_KEY = "kilo.integrations.gitlab"
    const val GITLAB_HOSTS_KEY = "kilo.integrations.gitlab.hosts"

    fun github(): Boolean = props()?.getBoolean(GITHUB_KEY, true) ?: true

    fun gitlab(): Boolean = props()?.getBoolean(GITLAB_KEY, false) ?: false

    /** Self-hosted GitLab hosts, for instances whose name does not say "gitlab". */
    fun hosts(): Set<String> = (props()?.getValue(GITLAB_HOSTS_KEY, "") ?: "")
        .split(',', ' ', '\n', ';')
        .map { it.trim().lowercase() }
        .filter { it.isNotEmpty() }
        .toSet()

    private fun props(): PropertiesComponent? = runCatching { PropertiesComponent.getInstance() }.getOrNull()
}

/** The host part of a git remote URL (`https://host/…`, `ssh://git@host:22/…`, `git@host:group/repo`). */
internal fun remoteHost(url: String): String? {
    val text = url.trim()
    if (text.isEmpty()) return null
    if (text.contains("://")) return runCatching { URI(text).host }.getOrNull()?.lowercase()
    val scp = Regex("^(?:[^@/]+@)?([^:/]+):").find(text) ?: return null
    return scp.groupValues[1].lowercase()
}

/** The project path of a git remote URL (`group/sub/repo`), without `.git`. */
internal fun remoteProject(url: String): String? {
    val text = url.trim()
    val path = if (text.contains("://")) {
        runCatching { URI(text).path }.getOrNull()
    } else {
        Regex("^(?:[^@/]+@)?[^:/]+:(.+)$").find(text)?.groupValues?.get(1)
    } ?: return null
    return path.trim('/').removeSuffix(".git").takeIf { it.isNotEmpty() }
}

/**
 * Which forge serves [origin], given the user's toggles. github.com is always GitHub. Any other host is
 * GitLab when the GitLab integration is on and the host says "gitlab" or is listed in [hosts]; otherwise it
 * is treated as GitHub (Enterprise), which is how Kilo behaved before GitLab support. Null means the
 * integration for that forge is off, so nothing may run.
 */
internal fun forgeFor(origin: String?, github: Boolean, gitlab: Boolean, hosts: Set<String>): Forge? {
    val host = origin?.let(::remoteHost)
    val isGithub = host != null && (host == "github.com" || host.endsWith(".github.com"))
    if (!isGithub && gitlab && host != null && (host.contains("gitlab") || host in hosts)) return Forge.GITLAB
    return if (github) Forge.GITHUB else null
}

/** A GitLab merge request URL: `https://host/group/repo/-/merge_requests/12`. */
internal data class MrRef(val host: String, val project: String, val iid: Int)

private val MR_URL = Regex("^https?://([^/]+)/(.+?)/-/merge_requests/(\\d+)(?:[/?#].*)?$")

internal fun parseMrUrl(url: String): MrRef? {
    val match = MR_URL.find(url.trim()) ?: return null
    val iid = match.groupValues[3].toIntOrNull() ?: return null
    return MrRef(match.groupValues[1].lowercase(), match.groupValues[2].trim('/'), iid)
}

/** Maps a GitLab merge request API object (as `glab … -F json` prints it) to the shared PR DTO. */
internal fun parseMr(path: String, obj: JsonObject): WorktreePrDto? {
    val iid = obj["iid"]?.jsonPrimitive?.intOrNull ?: return null
    val url = obj.str("web_url")?.takeIf { it.isNotBlank() } ?: return null
    val draft = obj["draft"]?.jsonPrimitive?.booleanOrNull == true ||
        obj["work_in_progress"]?.jsonPrimitive?.booleanOrNull == true
    val state = when (obj.str("state")?.lowercase()) {
        "merged" -> GhState.MERGED
        "closed", "locked" -> GhState.CLOSED
        else -> if (draft) GhState.DRAFT else GhState.OPEN
    }
    val pipeline = (obj["head_pipeline"] as? JsonObject) ?: (obj["pipeline"] as? JsonObject)
    val checks = when (pipeline?.str("status")?.lowercase()) {
        null, "skipped" -> GhChecksDto()
        "success" -> GhChecksDto(GhChecks.PASSED, total = 1, passed = 1)
        "failed", "canceled" -> GhChecksDto(GhChecks.FAILED, total = 1, failed = 1)
        else -> GhChecksDto(GhChecks.PENDING, total = 1, pending = 1)
    }
    val merge = when (obj["has_conflicts"]?.jsonPrimitive?.booleanOrNull) {
        true -> GhMerge.CONFLICTING
        else -> GhMerge.UNKNOWN
    }
    return WorktreePrDto(path, iid, state, url, obj.str("title")?.trim().orEmpty(), checks = checks, merge = merge)
}

/** Reads the source branch of a merge request and whether it comes from a fork. */
internal fun parseMrHead(raw: String): PrHead {
    val obj = parseObject(raw) ?: return PrHead()
    val ref = obj.str("source_branch")?.trim().orEmpty()
    val source = obj["source_project_id"]?.jsonPrimitive?.intOrNull
    val target = obj["target_project_id"]?.jsonPrimitive?.intOrNull
    val cross = source != null && target != null && source != target
    val owner = (obj["author"] as? JsonObject)?.str("username").orEmpty()
    return PrHead(ref, cross, owner)
}

/**
 * Resolves the merge request a checkout belongs to through `glab`, by source branch.
 *
 * `glab mr list` finds merge requests in every state, newest first; an open one wins over a merged or
 * closed one for the same branch. Only an open merge request pays for a second call, `glab mr view`, which
 * is the one that reports the head pipeline.
 */
internal class GitlabResolver(private val glab: (Path, List<String>, Int) -> CmdOut) {
    fun resolve(path: String, branch: String): WorktreePrDto? {
        if (branch.isBlank()) return null
        val dir = Path.of(path).normalize()
        val list = glab(dir, listOf("mr", "list", "--source-branch", branch, "--all", "--per-page", "5", "-F", "json"), GH_READ_TIMEOUT_MS)
        if (!list.ok) return null
        val items = (parse(list.stdout) as? JsonArray)?.mapNotNull { it as? JsonObject } ?: return null
        val pick = items.firstOrNull { it.str("state") == "opened" } ?: items.firstOrNull() ?: return null
        val base = parseMr(path, pick) ?: return null
        if (base.state != GhState.OPEN && base.state != GhState.DRAFT) return base
        val view = glab(dir, listOf("mr", "view", base.number.toString(), "-F", "json"), GH_READ_TIMEOUT_MS)
        if (!view.ok) return base
        return parseObject(view.stdout)?.let { parseMr(path, it) } ?: base
    }
}

/** Classifies a failed `glab` call into the shared availability verdicts. */
internal fun classifyGlabError(out: CmdOut): ai.kilocode.rpc.dto.GhAvailability {
    if (out.timeout) return ai.kilocode.rpc.dto.GhAvailability.TIMEOUT
    val text = (out.stderr + "\n" + out.stdout).lowercase()
    if (text.contains("cannot run program") || text.contains("no such file") || text.contains("command not found")) {
        return ai.kilocode.rpc.dto.GhAvailability.MISSING
    }
    if (text.contains("not logged") || text.contains("glab auth login") || text.contains("401") || text.contains("unauthorized")) {
        return ai.kilocode.rpc.dto.GhAvailability.UNAUTH
    }
    if (rateLimited(text)) return ai.kilocode.rpc.dto.GhAvailability.RATE_LIMITED
    return ai.kilocode.rpc.dto.GhAvailability.OK
}

private val json = Json { ignoreUnknownKeys = true }

private fun parse(raw: String): JsonElement? = runCatching { json.parseToJsonElement(raw) }.getOrNull()

private fun parseObject(raw: String): JsonObject? = parse(raw) as? JsonObject

private fun JsonObject.str(key: String): String? = this[key]?.jsonPrimitive?.contentOrNull
