package ai.kilocode.client.session.model

import java.awt.datatransfer.DataFlavor
import java.awt.datatransfer.Transferable
import java.awt.datatransfer.UnsupportedFlavorException
import java.awt.image.BufferedImage
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.util.Base64
import javax.imageio.ImageIO
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class ClipboardImageTest {
    private val png: ByteArray = ByteArrayOutputStream().also {
        ImageIO.write(BufferedImage(3, 2, BufferedImage.TYPE_INT_ARGB), "png", it)
    }.toByteArray()

    @Test
    fun `encoded png bytes on the clipboard are attached as they are`() {
        val flavor = DataFlavor("image/png; class=java.io.InputStream")
        val item = transferable(mapOf(flavor to { ByteArrayInputStream(png) }))

        assertTrue(PromptAttachmentExtractor.hasClipboardImage(item))
        val attachment = assertNotNull(PromptAttachmentExtractor.clipboardImage(item))
        assertEquals("image/png", attachment.mime)
        assertContentEquals(png, Base64.getDecoder().decode(attachment.url.substringAfter("base64,")))
    }

    @Test
    fun `a decoded image is used when no encoded flavor is offered`() {
        val item = transferable(mapOf(DataFlavor.imageFlavor to { BufferedImage(4, 4, BufferedImage.TYPE_INT_RGB) }))

        val attachment = assertNotNull(PromptAttachmentExtractor.clipboardImage(item))
        assertEquals("image/png", attachment.mime)
    }

    private fun transferable(data: Map<DataFlavor, () -> Any>) = object : Transferable {
        override fun getTransferDataFlavors(): Array<DataFlavor> = data.keys.toTypedArray()
        override fun isDataFlavorSupported(flavor: DataFlavor): Boolean = data.keys.any { it.equals(flavor) }
        override fun getTransferData(flavor: DataFlavor): Any =
            data.entries.firstOrNull { it.key.equals(flavor) }?.value?.invoke() ?: throw UnsupportedFlavorException(flavor)
    }
}
