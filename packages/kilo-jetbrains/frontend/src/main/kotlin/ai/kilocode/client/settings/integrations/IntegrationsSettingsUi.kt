package ai.kilocode.client.settings.integrations

import ai.kilocode.client.agentManager.worktree.GithubIntegrationListener
import ai.kilocode.client.agentManager.worktree.setGithubIntegration
import ai.kilocode.client.agentManager.worktree.setGitlabIntegration
import ai.kilocode.client.plugin.KiloBundle
import ai.kilocode.client.plugin.KiloPluginSettings
import ai.kilocode.client.settings.base.BaseContentPanel
import ai.kilocode.client.settings.base.SettingsPanel
import ai.kilocode.client.settings.base.SettingsRow
import ai.kilocode.client.settings.base.SettingsToggle
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.util.concurrency.annotations.RequiresEdt

/**
 * Integrations page. Every setting here is a local IDE preference, so the page renders immediately
 * and writes on toggle instead of going through [ai.kilocode.client.settings.base.BaseSettingsUi]'s
 * draft/apply flow, which would gate the UI on CLI readiness it does not need.
 */
internal class IntegrationsSettingsUi : SettingsPanel(), Disposable {
    private val github = SettingsToggle(KiloPluginSettings.getGithub()) { setGithubIntegration(it, "settings") }
    private val gitlab = SettingsToggle(KiloPluginSettings.getGitlab()) { setGitlabIntegration(it) }
    private val hosts = com.intellij.ui.components.JBTextField(KiloPluginSettings.getGitlabHosts()).apply {
        emptyText.text = KiloBundle.message("settings.integrations.gitlab.hosts.placeholder")
        document.addDocumentListener(object : com.intellij.ui.DocumentAdapter() {
            override fun textChanged(e: javax.swing.event.DocumentEvent) = KiloPluginSettings.setGitlabHosts(text)
        })
    }

    init {
        val content = BaseContentPanel()
        content.section(
            KiloBundle.message("settings.integrations.github.title"),
            KiloBundle.message("settings.integrations.github.description"),
        ).row(
            SettingsRow(
                KiloBundle.message("settings.integrations.github.enabled.title"),
                KiloBundle.message("settings.integrations.github.enabled.description"),
                github,
            ),
        )
        content.section(
            KiloBundle.message("settings.integrations.gitlab.title"),
            KiloBundle.message("settings.integrations.gitlab.description"),
        ).row(
            SettingsRow(
                KiloBundle.message("settings.integrations.gitlab.enabled.title"),
                KiloBundle.message("settings.integrations.gitlab.enabled.description"),
                gitlab,
            ),
        ).row(
            ai.kilocode.client.settings.base.SettingsStackedRow(
                KiloBundle.message("settings.integrations.gitlab.hosts.title"),
                KiloBundle.message("settings.integrations.gitlab.hosts.description"),
                hosts,
            ),
        )
        setContent(content)
        // The gh banner can turn the integration off while this page is open.
        ApplicationManager.getApplication().messageBus.connect(this)
            .subscribe(GithubIntegrationListener.TOPIC, GithubIntegrationListener { sync() })
    }

    @RequiresEdt
    fun sync() {
        val value = KiloPluginSettings.getGithub()
        if (github.isSelected != value) github.isSelected = value
        val lab = KiloPluginSettings.getGitlab()
        if (gitlab.isSelected != lab) gitlab.isSelected = lab
    }

    override fun dispose() = Unit
}
