package ai.kilocode.client.diff

import ai.kilocode.rpc.dto.DiffFileDto
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.components.StoragePathMacros
import com.intellij.openapi.project.Project
import java.security.MessageDigest

/**
 * Which diff files the user marked as viewed, per checkout directory and file, with a fingerprint of what
 * they saw. A file stays viewed until its change differs from that fingerprint, so a new edit to the file
 * brings it back, while switching the compare scope or reopening the IDE keeps it.
 */
@Service(Service.Level.PROJECT)
@State(name = "KiloDiffViewed", storages = [Storage(StoragePathMacros.WORKSPACE_FILE)])
internal class DiffViewedStore : PersistentStateComponent<DiffViewedStore.Data> {
    class Data {
        /** `directory|file` → fingerprint, oldest first. */
        var viewed: MutableMap<String, String> = LinkedHashMap()
    }

    private var data = Data()

    override fun getState(): Data = data

    override fun loadState(state: Data) {
        data = state
    }

    fun viewed(directory: String?, file: DiffFileDto): Boolean {
        val stored = data.viewed[key(directory, file.file)] ?: return false
        return stored == fingerprint(file)
    }

    fun set(directory: String?, file: DiffFileDto, viewed: Boolean) {
        val key = key(directory, file.file)
        data.viewed.remove(key)
        if (!viewed) return
        data.viewed[key] = fingerprint(file)
        // Keep the newest entries only; old checkouts and long-merged changes are not worth keeping.
        while (data.viewed.size > LIMIT) data.viewed.remove(data.viewed.keys.first())
    }

    companion object {
        private const val LIMIT = 5_000

        fun getInstance(project: Project): DiffViewedStore = project.getService(DiffViewedStore::class.java)

        private fun key(directory: String?, file: String) = "${directory.orEmpty()}|$file"

        /**
         * What the user reviewed: the file's new content when the diff carries it (so a different compare
         * scope over the same content keeps the mark), else its patch and stats.
         */
        internal fun fingerprint(file: DiffFileDto): String {
            val text = file.after ?: "${file.status}\n${file.additions}/${file.deletions}\n${file.patch.orEmpty()}"
            val bytes = MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8))
            return bytes.take(16).joinToString("") { "%02x".format(it) }
        }
    }
}
