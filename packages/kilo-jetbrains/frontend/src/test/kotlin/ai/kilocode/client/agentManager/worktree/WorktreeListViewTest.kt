package ai.kilocode.client.agentManager.worktree

import ai.kilocode.client.session.SessionActivityKind
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class WorktreeListViewTest {
    @Test
    fun `state puts anything waiting on the user first and remembers a finished run`() {
        assertEquals(WorktreeState.ATTENTION, worktreeState(SessionActivityKind.QUESTION, finished = true))
        assertEquals(WorktreeState.ATTENTION, worktreeState(SessionActivityKind.ERROR, finished = false))
        assertEquals(WorktreeState.RUNNING, worktreeState(SessionActivityKind.RUNNING, finished = true))
        assertEquals(WorktreeState.FINISHED, worktreeState(null, finished = true))
        assertEquals(WorktreeState.IDLE, worktreeState(null, finished = false))
    }

    @Test
    fun `branch prefix is the part before the first slash`() {
        assertEquals("feature", branchPrefix("feature/anti-dupe"))
        assertEquals("change", branchPrefix("change/cobblemon-1.8.4"))
        assertNull(branchPrefix("feature-events"))
        assertNull(branchPrefix("/odd"))
    }
}
