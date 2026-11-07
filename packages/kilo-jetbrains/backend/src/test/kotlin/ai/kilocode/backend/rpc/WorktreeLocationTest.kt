package ai.kilocode.backend.rpc

import ai.kilocode.backend.workspace.KiloWorktreeLocationSettings
import ai.kilocode.rpc.dto.CreateWorktreeRequestDto
import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.execution.process.CapturingProcessHandler
import kotlinx.coroutines.runBlocking
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Worktrees outside `.kilo/worktrees`: listed, hidden, added back, created in a custom location, and never deleted unless Kilo created them. */
class WorktreeLocationTest {
    private val repo: Path = Files.createTempDirectory("kilo-loc").toRealPath()
    private val outside: Path = Files.createTempDirectory("kilo-loc-out").toRealPath()
    private val api = KiloWorktreeRpcApiImpl()

    @AfterTest
    fun tearDown() {
        KiloWorktreeLocationSettings.set("")
        outside.toFile().deleteRecursively()
        repo.toFile().deleteRecursively()
    }

    @Test
    fun `resolve expands the default, relative, home and repo forms`() {
        val root = Path.of("/work/core")
        assertEquals(Path.of("/work/core/.kilo/worktrees"), KiloWorktreeLocationSettings.resolve(root, ""))
        assertEquals(Path.of("/work/core/.worktrees"), KiloWorktreeLocationSettings.resolve(root, " .worktrees "))
        assertEquals(Path.of("/work/core-trees"), KiloWorktreeLocationSettings.resolve(root, "../{repo}-trees"))
        assertEquals(Path.of("/home/me/trees/core"), KiloWorktreeLocationSettings.resolve(root, "~/trees/{repo}", home = "/home/me"))
        assertEquals(Path.of("/abs"), KiloWorktreeLocationSettings.resolve(root, "/abs"))
    }

    @Test
    fun `worktrees the user made elsewhere are listed but never deleted`() = runBlocking {
        init()
        val mine = repo.resolve(".worktrees").resolve("feature")
        git(repo, "worktree", "add", "-b", "feature", mine.toString())

        val listed = api.list(repo.toString()).worktrees
        val row = listed.single { it.path == mine.toString() }
        assertFalse(row.created, "Kilo did not create this worktree")

        val result = api.remove(repo.toString(), row.path, "feature", force = true)
        assertNotNull(result.error)
        assertTrue(Files.isDirectory(mine), "a worktree Kilo did not create stays on disk")
        assertTrue(git(repo, "branch", "--list", "feature").contains("feature"), "and keeps its branch")
    }

    @Test
    fun `hide takes a worktree off the list and addExisting brings it back`() = runBlocking {
        init()
        val mine = outside.resolve("side")
        git(repo, "worktree", "add", "-b", "side", mine.toString())

        assertTrue(api.hide(repo.toString(), mine.toString()))
        assertFalse(api.list(repo.toString()).worktrees.any { it.path == mine.toString() })
        assertTrue(Files.isDirectory(mine))
        assertTrue(api.dirty(repo.toString()).items.none { it.path == mine.toString() })

        val added = api.addExisting(repo.toString(), mine.toString())
        assertNull(added.error)
        assertEquals(mine.toString(), added.worktree?.path)
        assertTrue(api.list(repo.toString()).worktrees.any { it.path == mine.toString() })
    }

    @Test
    fun `addExisting refuses a folder that is not a worktree of this repository`() = runBlocking {
        init()
        val other = outside.resolve("other")
        Files.createDirectories(other)
        git(other, "init")

        val result = api.addExisting(repo.toString(), other.toString())
        assertNull(result.worktree)
        assertTrue(result.error!!.contains("not a worktree"), result.error)
    }

    @Test
    fun `new worktrees go to the configured location and count as created`() = runBlocking {
        init()
        KiloWorktreeLocationSettings.set(outside.resolve("{repo}").toString())

        val created = assertNotNull(api.create(repo.toString(), CreateWorktreeRequestDto("feature/loc")).worktree)
        val expected = outside.resolve(repo.fileName.toString()).resolve("feature-loc")
        assertEquals(expected.toString(), created.path)
        assertTrue(created.created)
        assertTrue(api.list(repo.toString()).worktrees.single { it.path == created.path }.created)

        val removed = api.remove(repo.toString(), created.path, "feature/loc", force = false)
        assertNull(removed.error)
        assertTrue(removed.ok)
        // Removal stages the directory for a background reap, so it is gone from its own path at once.
        assertFalse(Files.exists(expected))
    }

    private fun init() {
        git(repo, "init")
        git(repo, "config", "user.email", "test@kilo.ai")
        git(repo, "config", "user.name", "Kilo Test")
        Files.writeString(repo.resolve("README.md"), "hello")
        git(repo, "add", "README.md")
        git(repo, "commit", "-m", "init")
    }

    private fun git(dir: Path, vararg args: String): String {
        val out = CapturingProcessHandler(GeneralCommandLine(listOf("git") + args).withWorkingDirectory(dir)).runProcess(30_000)
        check(out.exitCode == 0) { "git ${args.joinToString(" ")} failed: ${out.stderr}" }
        return out.stdout
    }
}
