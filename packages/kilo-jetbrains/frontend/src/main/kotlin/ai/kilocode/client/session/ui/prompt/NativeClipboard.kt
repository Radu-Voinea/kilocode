package ai.kilocode.client.session.ui.prompt

import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.util.SystemInfo
import java.awt.datatransfer.DataFlavor
import java.awt.datatransfer.Transferable
import java.awt.datatransfer.UnsupportedFlavorException
import java.io.ByteArrayInputStream
import java.io.File
import java.net.URI
import java.util.concurrent.TimeUnit

/**
 * Reads images and copied files straight from the Linux desktop clipboard with `wl-paste` (Wayland) or
 * `xclip` (X11).
 *
 * The IDE's native Wayland toolkit hands the editor no clipboard contents at all for a copied screenshot,
 * and may keep offering its own last text copy instead, so an image paste never reaches the prompt. The
 * clipboard tools see what the desktop actually holds.
 */
internal object NativeClipboard {
    private val LOG = Logger.getInstance(NativeClipboard::class.java)
    private val IMAGES = listOf("image/png", "image/jpeg", "image/webp", "image/gif")
    private const val TIMEOUT_MS = 2_000L

    /** A clipboard reader: the listed types, and the bytes of one type. */
    internal interface Source {
        fun types(): List<String>?

        fun read(type: String): ByteArray?
    }

    @Volatile
    internal var source: Source? = detect()

    /**
     * An image or file list the desktop clipboard holds, as a [Transferable] the attachment code reads, or
     * null when it holds neither (or no clipboard tool is installed). An image that comes with plain text,
     * as office apps copy cells, is left to the IDE's text paste unless the IDE saw no contents at all.
     */
    fun attachable(ideEmpty: Boolean): Transferable? {
        val src = source ?: return null
        val types = src.types()?.map { it.trim().lowercase() }?.filter { it.isNotEmpty() } ?: return null
        LOG.info("prompt paste native types=${types.joinToString()}")
        if ("text/uri-list" in types) {
            val files = src.read("text/uri-list")?.let { files(String(it, Charsets.UTF_8)) }.orEmpty()
            if (files.isNotEmpty()) return FilesTransferable(files)
        }
        if (!ideEmpty && "text/plain" in types) return null
        val mime = IMAGES.firstOrNull { it in types } ?: return null
        val bytes = src.read(mime)?.takeIf { it.isNotEmpty() } ?: return null
        return ImageTransferable(mime, bytes)
    }

    /** Existing local files named by a `text/uri-list` payload. */
    internal fun files(list: String): List<File> = list.lineSequence()
        .map { it.trim() }
        .filter { it.startsWith("file:") }
        .mapNotNull { runCatching { File(URI(it)) }.getOrNull() }
        .filter { it.exists() }
        .toList()

    private fun detect(): Source? {
        if (!SystemInfo.isLinux) return null
        val env = System.getenv()
        if (!env["WAYLAND_DISPLAY"].isNullOrBlank() && onPath("wl-paste")) {
            return Command(listOf("wl-paste", "--list-types")) { listOf("wl-paste", "--no-newline", "--type", it) }
        }
        if (!env["DISPLAY"].isNullOrBlank() && onPath("xclip")) {
            return Command(listOf("xclip", "-selection", "clipboard", "-t", "TARGETS", "-o")) {
                listOf("xclip", "-selection", "clipboard", "-t", it, "-o")
            }
        }
        return null
    }

    private fun onPath(name: String): Boolean =
        System.getenv("PATH").orEmpty().split(File.pathSeparator).any { File(it, name).canExecute() }

    private class Command(private val list: List<String>, private val get: (String) -> List<String>) : Source {
        override fun types(): List<String>? = run(list)?.let { String(it, Charsets.UTF_8).lines() }

        override fun read(type: String): ByteArray? = run(get(type))

        private fun run(cmd: List<String>): ByteArray? = runCatching {
            val proc = ProcessBuilder(cmd).redirectError(ProcessBuilder.Redirect.DISCARD).start()
            proc.outputStream.close()
            val out = java.util.concurrent.CompletableFuture.supplyAsync { proc.inputStream.use { it.readBytes() } }
            if (!proc.waitFor(TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
                proc.destroyForcibly()
                LOG.info("prompt paste native timeout cmd=${cmd.first()}")
                return null
            }
            if (proc.exitValue() != 0) return null
            out.get(TIMEOUT_MS, TimeUnit.MILLISECONDS)
        }.onFailure { LOG.info("prompt paste native failed cmd=${cmd.first()}: ${it.message}") }.getOrNull()
    }

    private class FilesTransferable(private val files: List<File>) : Transferable {
        override fun getTransferDataFlavors(): Array<DataFlavor> = arrayOf(DataFlavor.javaFileListFlavor)

        override fun isDataFlavorSupported(flavor: DataFlavor): Boolean = flavor == DataFlavor.javaFileListFlavor

        override fun getTransferData(flavor: DataFlavor): Any {
            if (!isDataFlavorSupported(flavor)) throw UnsupportedFlavorException(flavor)
            return files
        }
    }

    internal class ImageTransferable(mime: String, private val bytes: ByteArray) : Transferable {
        private val flavor = DataFlavor("$mime; class=java.io.InputStream")

        override fun getTransferDataFlavors(): Array<DataFlavor> = arrayOf(flavor)

        override fun isDataFlavorSupported(flavor: DataFlavor): Boolean = flavor == this.flavor

        override fun getTransferData(flavor: DataFlavor): Any {
            if (!isDataFlavorSupported(flavor)) throw UnsupportedFlavorException(flavor)
            return ByteArrayInputStream(bytes)
        }
    }
}
