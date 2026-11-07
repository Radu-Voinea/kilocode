package ai.kilocode.client.agentManager

import ai.kilocode.rpc.dto.WorktreeDto
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class WorktreeGatingTest {
    private val kilo = WorktreeDto("/r/.kilo/worktrees/a", "a", "a", "/r/.kilo/worktrees/a", created = true)
    private val user = WorktreeDto("/r/.worktrees/b", "b", "b", "/r/.worktrees/b", created = false)
    private val main = WorktreeDto("/r", "r", "main", "/r", main = true)

    @Test
    fun `only worktrees Kilo created can be deleted`() {
        assertTrue(worktreeDeletable(kilo, busy = false))
        assertFalse(worktreeDeletable(user, busy = false))
        assertFalse(worktreeDeletable(main, busy = false))
        assertFalse(worktreeDeletable(kilo, busy = true))
    }

    @Test
    fun `worktrees Kilo did not create can only be taken off the list`() {
        assertTrue(worktreeHideable(user, busy = false))
        assertFalse(worktreeHideable(kilo, busy = false))
        assertFalse(worktreeHideable(main, busy = false))
        assertFalse(worktreeHideable(user, busy = true))
    }
}
