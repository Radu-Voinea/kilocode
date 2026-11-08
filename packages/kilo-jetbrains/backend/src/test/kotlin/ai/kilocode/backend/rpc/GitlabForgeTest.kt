package ai.kilocode.backend.rpc

import ai.kilocode.rpc.dto.GhChecks
import ai.kilocode.rpc.dto.GhMerge
import ai.kilocode.rpc.dto.GhState
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class GitlabForgeTest {
    @Test
    fun `remote host and project are read from https, ssh and scp style urls`() {
        assertEquals("gitlab.com", remoteHost("https://gitlab.com/group/sub/repo.git"))
        assertEquals("git.example.com", remoteHost("ssh://git@git.example.com:2222/group/repo.git"))
        assertEquals("gitlab.com", remoteHost("git@gitlab.com:group/repo.git"))
        assertEquals("group/sub/repo", remoteProject("https://gitlab.com/group/sub/repo.git"))
        assertEquals("group/repo", remoteProject("git@gitlab.com:group/repo.git"))
        assertEquals("group/repo", remoteProject("ssh://git@git.example.com:2222/group/repo.git"))
    }

    @Test
    fun `forge follows the remote host and the toggles`() {
        val lab = "git@gitlab.com:group/repo.git"
        val hub = "https://github.com/owner/repo.git"
        val own = "https://git.example.com/group/repo.git"
        assertEquals(Forge.GITLAB, forgeFor(lab, github = true, gitlab = true, hosts = emptySet()))
        assertEquals(Forge.GITHUB, forgeFor(lab, github = true, gitlab = false, hosts = emptySet()))
        assertNull(forgeFor(lab, github = false, gitlab = false, hosts = emptySet()))
        assertEquals(Forge.GITHUB, forgeFor(hub, github = true, gitlab = true, hosts = setOf("github.com")))
        assertNull(forgeFor(hub, github = false, gitlab = true, hosts = emptySet()))
        assertEquals(Forge.GITLAB, forgeFor(own, github = true, gitlab = true, hosts = setOf("git.example.com")))
        assertEquals(Forge.GITHUB, forgeFor(own, github = true, gitlab = true, hosts = emptySet()))
    }

    @Test
    fun `merge request urls are parsed with nested groups`() {
        assertEquals(MrRef("gitlab.com", "group/sub/repo", 42), parseMrUrl("https://gitlab.com/group/sub/repo/-/merge_requests/42"))
        assertEquals(MrRef("git.example.com", "a/b", 7), parseMrUrl("https://git.example.com/a/b/-/merge_requests/7/diffs"))
        assertNull(parseMrUrl("https://github.com/owner/repo/pull/1"))
    }

    @Test
    fun `resolver picks the open merge request and reads its pipeline`() {
        val calls = mutableListOf<List<String>>()
        val list = """[{"iid":3,"state":"merged","title":"old","web_url":"https://gitlab.com/g/r/-/merge_requests/3"},
            {"iid":9,"state":"opened","draft":true,"title":"new","web_url":"https://gitlab.com/g/r/-/merge_requests/9"}]"""
        val view = """{"iid":9,"state":"opened","draft":true,"title":"new","has_conflicts":true,
            "web_url":"https://gitlab.com/g/r/-/merge_requests/9","head_pipeline":{"status":"running"}}"""
        val resolver = GitlabResolver { _: Path, args: List<String>, _: Int ->
            calls += args
            CmdOut(0, if (args[1] == "list") list else view, "")
        }
        val pr = resolver.resolve("/repo/wt", "feature/x")!!
        assertEquals(9, pr.number)
        assertEquals(GhState.DRAFT, pr.state)
        assertEquals(GhChecks.PENDING, pr.checks.state)
        assertEquals(GhMerge.CONFLICTING, pr.merge)
        assertTrue(calls[0].containsAll(listOf("--source-branch", "feature/x", "--all")))
        assertEquals(listOf("mr", "view", "9", "-F", "json"), calls[1])
    }

    @Test
    fun `a merged merge request costs one call and a failed list answers nothing`() {
        var count = 0
        val merged = GitlabResolver { _, _, _ ->
            count++
            CmdOut(0, """[{"iid":4,"state":"merged","title":"t","web_url":"https://gitlab.com/g/r/-/merge_requests/4"}]""", "")
        }
        assertEquals(GhState.MERGED, merged.resolve("/repo", "b")!!.state)
        assertEquals(1, count)
        assertNull(GitlabResolver { _, _, _ -> CmdOut(1, "", "glab: not logged in") }.resolve("/repo", "b"))
    }

    @Test
    fun `merge request head marks fork sources as cross project`() {
        val head = parseMrHead("""{"source_branch":"fix","source_project_id":2,"target_project_id":1,"author":{"username":"Ann"}}""")
        assertEquals(PrHead("fix", true, "Ann"), head)
        assertEquals("ann/fix", prBranchName(head, 5))
        assertEquals(PrHead("main", false, ""), parseMrHead("""{"source_branch":"main","source_project_id":1,"target_project_id":1}"""))
    }

    @Test
    fun `fork merge requests are fetched through the merge request ref`() {
        val runs = mutableListOf<List<String>>()
        val failure = fetchMrBranch({ args -> runs += args; CmdOut(0, "", "") }, 5, PrHead("fix", true, "ann"), "ann/fix")
        assertNull(failure)
        assertEquals(listOf("fetch", "origin", "+refs/merge-requests/5/head:ann/fix"), runs[0])
        assertEquals(listOf("config", "branch.ann/fix.merge", "refs/merge-requests/5/head"), runs.last())
    }

    @Test
    fun `glab errors are classified`() {
        assertEquals(ai.kilocode.rpc.dto.GhAvailability.MISSING, classifyGlabError(CmdOut(-1, "", "Cannot run program \"glab\"")))
        assertEquals(ai.kilocode.rpc.dto.GhAvailability.UNAUTH, classifyGlabError(CmdOut(1, "", "You are not logged into any GitLab hosts")))
        assertEquals(ai.kilocode.rpc.dto.GhAvailability.TIMEOUT, classifyGlabError(CmdOut(-1, "", "", timeout = true)))
    }
}
