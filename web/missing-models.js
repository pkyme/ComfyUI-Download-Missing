import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { $el, ComfyDialog } from "../../scripts/ui.js";
import { ComfyButton } from "../../scripts/ui/components/button.js";
import { ComfyButtonGroup } from "../../scripts/ui/components/buttonGroup.js";

/**
 * Dialog for displaying and downloading missing models
 */
class MissingModelsDialog extends ComfyDialog {
    constructor() {
        super();
        this.missingModels = [];
        this.downloadingModels = new Set();
        this.progressInterval = null;

        this.element = $el("div.comfy-modal", {
            id: 'missing-models-dialog',
            parent: document.body,
            style: {
                width: '900px',
                maxHeight: '80vh',
                overflow: 'hidden',
                display: 'none',
                zIndex: 1000,
                position: 'fixed',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                opacity: '0',
                transition: 'opacity 0.3s ease-in-out'
            }
        }, [
            this.createContent()
        ]);
    }

    createContent() {
        this.titleElement = $el("div.cm-title", {
            style: {
                padding: '16px 20px',
                backgroundColor: '#1a1a1a',
                borderBottom: '2px solid #444',
                textAlign: 'center',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '100%',
                boxSizing: 'border-box',
                flexShrink: '0'
            }
        }, [
            $el("h2", {
                textContent: "Download Missing Models",
                style: {
                    margin: '0',
                    color: '#fff',
                    fontSize: '18px',
                    fontWeight: '600',
                    letterSpacing: '0.3px',
                    lineHeight: '1.2'
                }
            })
        ]);

        this.statusElement = $el("div.status-bar", {
            style: {
                padding: '12px 20px',
                backgroundColor: '#252525',
                borderBottom: '1px solid #444',
                color: '#aaa',
                fontSize: '14px',
                lineHeight: '1.5',
                fontWeight: '400'
            }
        }, [
            $el("span", { textContent: "Scanning workflow for missing models..." })
        ]);

        this.modelsListElement = $el("div.models-list", {
            style: {
                padding: '16px 20px',
                maxHeight: 'calc(80vh - 250px)',
                overflowY: 'auto',
                backgroundColor: '#2a2a2a'
            }
        }, [
            $el("div", {
                textContent: "No models scanned yet",
                style: {
                    textAlign: 'center',
                    color: '#666',
                    padding: '40px',
                    fontSize: '14px',
                    lineHeight: '1.5'
                }
            })
        ]);

        this.buttonsElement = $el("div.button-bar", {
            style: {
                padding: '15px',
                backgroundColor: '#1a1a1a',
                borderTop: '1px solid #444',
                display: 'flex',
                gap: '12px',
                justifyContent: 'center'
            }
        }, [
            $el("button", {
                textContent: "Download All",
                className: "comfyui-button",
                style: {
                    padding: '10px 24px',
                    backgroundColor: '#28a745',
                    color: '#fff',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontSize: '14px',
                    fontWeight: '500',
                    transition: 'all 0.2s ease',
                    boxShadow: '0 2px 4px rgba(40, 167, 69, 0.3)'
                },
                onmouseenter: (e) => {
                    e.currentTarget.style.backgroundColor = '#218838';
                    e.currentTarget.style.transform = 'translateY(-1px)';
                    e.currentTarget.style.boxShadow = '0 4px 8px rgba(40, 167, 69, 0.4)';
                },
                onmouseleave: (e) => {
                    e.currentTarget.style.backgroundColor = '#28a745';
                    e.currentTarget.style.transform = 'translateY(0)';
                    e.currentTarget.style.boxShadow = '0 2px 4px rgba(40, 167, 69, 0.3)';
                },
                onmousedown: (e) => {
                    e.currentTarget.style.transform = 'translateY(0) scale(0.98)';
                },
                onmouseup: (e) => {
                    e.currentTarget.style.transform = 'translateY(-1px) scale(1)';
                },
                onclick: () => this.downloadAllModels()
            }),
            $el("button", {
                textContent: "Close",
                className: "comfyui-button",
                style: {
                    padding: '10px 24px',
                    backgroundColor: '#666',
                    color: '#fff',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontSize: '14px',
                    fontWeight: '500',
                    transition: 'all 0.2s ease',
                    boxShadow: '0 2px 4px rgba(0, 0, 0, 0.2)'
                },
                onmouseenter: (e) => {
                    e.currentTarget.style.backgroundColor = '#555';
                    e.currentTarget.style.transform = 'translateY(-1px)';
                    e.currentTarget.style.boxShadow = '0 4px 8px rgba(0, 0, 0, 0.3)';
                },
                onmouseleave: (e) => {
                    e.currentTarget.style.backgroundColor = '#666';
                    e.currentTarget.style.transform = 'translateY(0)';
                    e.currentTarget.style.boxShadow = '0 2px 4px rgba(0, 0, 0, 0.2)';
                },
                onmousedown: (e) => {
                    e.currentTarget.style.transform = 'translateY(0) scale(0.98)';
                },
                onmouseup: (e) => {
                    e.currentTarget.style.transform = 'translateY(-1px) scale(1)';
                },
                onclick: () => this.close()
            })
        ]);

        return $el("div.comfy-modal-content", {
            style: {
                backgroundColor: '#2a2a2a',
                borderRadius: '8px',
                overflow: 'hidden',
                boxShadow: '0 8px 32px rgba(0, 0, 0, 0.6)',
                border: '1px solid #444',
                display: 'flex',
                flexDirection: 'column'
            }
        }, [
            this.titleElement,
            this.statusElement,
            this.modelsListElement,
            this.buttonsElement
        ]);
    }

    async scanWorkflow() {
        try {
            this.updateStatus("Scanning workflow...", "info");

            // Get current workflow
            const workflow = app.graph.serialize();

            // Call backend API
            const response = await api.fetchApi('/download-missing/scan', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workflow })
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const result = await response.json();

            if (result.status === 'success') {
                this.missingModels = result.missing_models || [];
                this.displayModels();

                if (this.missingModels.length === 0) {
                    this.updateStatus("No missing models found! All models are installed.", "success");
                } else {
                    this.updateStatus(
                        `Found ${this.missingModels.length} missing model(s). Click 'Download All' to download them.`,
                        "warning"
                    );
                }
            } else {
                throw new Error(result.message || "Unknown error");
            }
        } catch (error) {
            console.error("[Missing Models] Scan error:", error);
            this.updateStatus(`Error scanning workflow: ${error.message}`, "error");
        }
    }

    displayModels() {
        this.modelsListElement.innerHTML = '';

        if (this.missingModels.length === 0) {
            this.modelsListElement.appendChild(
                $el("div", {
                    textContent: "No missing models found",
                    style: {
                        textAlign: 'center',
                        color: '#666',
                        padding: '40px',
                        fontSize: '14px',
                        lineHeight: '1.5'
                    }
                })
            );
            return;
        }

        this.missingModels.forEach((model, index) => {
            const modelCard = this.createModelCard(model, index);
            this.modelsListElement.appendChild(modelCard);
        });
    }

    createModelCard(model, index) {
        const hasUrl = model.url && model.url.trim() !== '';

        const progressBar = $el("div.progress-bar", {
            style: {
                width: '100%',
                height: '6px',
                backgroundColor: '#444',
                borderRadius: '3px',
                marginTop: '8px',
                overflow: 'hidden',
                display: 'none',
                boxShadow: 'inset 0 1px 3px rgba(0, 0, 0, 0.3)'
            }
        }, [
            $el("div.progress-fill", {
                style: {
                    width: '0%',
                    height: '100%',
                    background: 'linear-gradient(90deg, #0066cc 0%, #00A0E3 100%)',
                    transition: 'width 0.3s ease',
                    boxShadow: '0 0 10px rgba(0, 102, 204, 0.5)',
                    animation: 'none'
                }
            })
        ]);

        const statusText = $el("div.status-text", {
            style: {
                fontSize: '12px',
                color: '#aaa',
                marginTop: '6px',
                display: 'none',
                lineHeight: '1.5',
                fontWeight: '400'
            }
        });

        const downloadButton = $el("button", {
            textContent: hasUrl ? "Download" : "No URL",
            disabled: !hasUrl,
            style: {
                padding: '8px 18px',
                backgroundColor: hasUrl ? '#0066cc' : '#444',
                color: '#fff',
                border: 'none',
                borderRadius: '4px',
                cursor: hasUrl ? 'pointer' : 'not-allowed',
                fontSize: '13px',
                fontWeight: '500',
                transition: 'all 0.2s ease',
                boxShadow: hasUrl ? '0 2px 4px rgba(0, 102, 204, 0.3)' : 'none'
            },
            onmouseenter: (e) => {
                if (hasUrl && !e.currentTarget.disabled) {
                    e.currentTarget.style.backgroundColor = '#0052a3';
                    e.currentTarget.style.transform = 'translateY(-1px)';
                    e.currentTarget.style.boxShadow = '0 4px 8px rgba(0, 102, 204, 0.4)';
                }
            },
            onmouseleave: (e) => {
                if (hasUrl && !e.currentTarget.disabled) {
                    e.currentTarget.style.backgroundColor = '#0066cc';
                    e.currentTarget.style.transform = 'translateY(0)';
                    e.currentTarget.style.boxShadow = '0 2px 4px rgba(0, 102, 204, 0.3)';
                }
            },
            onmousedown: (e) => {
                if (hasUrl && !e.currentTarget.disabled) {
                    e.currentTarget.style.transform = 'translateY(0) scale(0.98)';
                }
            },
            onmouseup: (e) => {
                if (hasUrl && !e.currentTarget.disabled) {
                    e.currentTarget.style.transform = 'translateY(-1px) scale(1)';
                }
            },
            onclick: async () => {
                if (hasUrl) {
                    await this.downloadModel(model, progressBar, statusText, downloadButton);
                }
            }
        });

        const card = $el("div.model-card", {
            style: {
                backgroundColor: '#333',
                padding: '16px',
                marginBottom: '12px',
                borderRadius: '6px',
                border: '1px solid #444',
                boxShadow: '0 2px 8px rgba(0, 0, 0, 0.3)'
            }
        }, [
            $el("div", {
                style: {
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start'
                }
            }, [
                $el("div", {
                    style: { flex: '1', marginRight: '15px' }
                }, [
                    $el("div", {
                        textContent: model.name,
                        style: {
                            fontWeight: '600',
                            color: '#fff',
                            fontSize: '15px',
                            marginBottom: '8px',
                            wordBreak: 'break-word',
                            lineHeight: '1.4',
                            letterSpacing: '0.2px'
                        }
                    }),
                    $el("div", {
                        textContent: `Directory: models/${model.directory || model.folder}`,
                        style: {
                            fontSize: '12px',
                            color: '#888',
                            marginBottom: '6px',
                            lineHeight: '1.5',
                            fontWeight: '400'
                        }
                    }),
                    hasUrl ? $el("div", {
                        textContent: `URL: ${this.truncateUrl(model.url)}`,
                        title: model.url,
                        style: {
                            fontSize: '11px',
                            color: '#666',
                            fontFamily: 'monospace',
                            lineHeight: '1.5',
                            fontWeight: '400'
                        }
                    }) : $el("div", {
                        textContent: "URL: Not available - manual download required",
                        style: {
                            fontSize: '11px',
                            color: '#c44',
                            fontStyle: 'italic',
                            lineHeight: '1.5',
                            fontWeight: '400'
                        }
                    }),
                    progressBar,
                    statusText
                ]),
                downloadButton
            ])
        ]);

        // Store references for later updates
        model._progressBar = progressBar;
        model._statusText = statusText;
        model._downloadButton = downloadButton;
        model._card = card;

        return card;
    }

    truncateUrl(url, maxLength = 60) {
        if (url.length <= maxLength) return url;
        return url.substring(0, maxLength - 3) + '...';
    }

    async downloadModel(model, progressBar, statusText, downloadButton) {
        if (this.downloadingModels.has(model.name)) {
            return; // Already downloading
        }

        try {
            this.downloadingModels.add(model.name);

            // Update UI
            downloadButton.textContent = "Downloading...";
            downloadButton.disabled = true;
            progressBar.style.display = 'block';
            statusText.style.display = 'block';
            statusText.textContent = 'Starting download...';
            statusText.style.color = '#aaa';

            // Start download
            const response = await api.fetchApi('/download-missing/download', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model_name: model.name,
                    model_url: model.url,
                    model_folder: model.folder
                })
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            // Start polling for progress
            this.pollProgress(model);

        } catch (error) {
            console.error("[Missing Models] Download error:", error);
            this.downloadingModels.delete(model.name);

            statusText.textContent = `Error: ${error.message}`;
            statusText.style.color = '#f44';
            statusText.style.display = 'block';
            downloadButton.textContent = "Retry";
            downloadButton.disabled = false;
        }
    }

    async pollProgress(model) {
        const pollInterval = setInterval(async () => {
            try {
                const response = await api.fetchApi(`/download-missing/status/${encodeURIComponent(model.name)}`);

                if (!response.ok) {
                    clearInterval(pollInterval);
                    return;
                }

                const result = await response.json();

                if (result.status === 'success' && result.progress) {
                    const progress = result.progress;

                    // Update progress bar
                    const progressFill = model._progressBar.querySelector('.progress-fill');
                    if (progressFill) {
                        progressFill.style.width = `${progress.progress}%`;
                    }

                    // Update status text
                    if (progress.status === 'downloading') {
                        const downloadedMB = (progress.downloaded / (1024 * 1024)).toFixed(2);
                        const totalMB = (progress.total / (1024 * 1024)).toFixed(2);
                        model._statusText.textContent = `Downloading: ${downloadedMB} MB / ${totalMB} MB (${progress.progress}%)`;
                        model._statusText.style.color = '#6c9';
                        // Add pulsing animation
                        if (progressFill) {
                            progressFill.classList.add('progress-downloading');
                        }
                    } else if (progress.status === 'completed') {
                        clearInterval(pollInterval);
                        this.downloadingModels.delete(model.name);

                        // Remove pulsing animation
                        if (progressFill) {
                            progressFill.classList.remove('progress-downloading');
                        }

                        model._statusText.textContent = 'Download completed!';
                        model._statusText.style.color = '#6c9';
                        model._downloadButton.textContent = "Completed";
                        model._downloadButton.style.backgroundColor = '#28a745';
                        model._card.style.opacity = '0.7';
                    } else if (progress.status === 'error') {
                        clearInterval(pollInterval);
                        this.downloadingModels.delete(model.name);

                        model._statusText.textContent = `Error: ${progress.error || 'Unknown error'}`;
                        model._statusText.style.color = '#f44';
                        model._downloadButton.textContent = "Retry";
                        model._downloadButton.disabled = false;
                    } else if (progress.status === 'cancelled') {
                        clearInterval(pollInterval);
                        this.downloadingModels.delete(model.name);

                        model._statusText.textContent = 'Download cancelled';
                        model._statusText.style.color = '#fa4';
                        model._downloadButton.textContent = "Download";
                        model._downloadButton.disabled = false;
                    }
                }
            } catch (error) {
                console.error("[Missing Models] Poll error:", error);
                clearInterval(pollInterval);
            }
        }, 500); // Poll every 500ms
    }

    async downloadAllModels() {
        const modelsWithUrls = this.missingModels.filter(m => m.url && m.url.trim() !== '');

        if (modelsWithUrls.length === 0) {
            this.updateStatus("No models with URLs to download", "warning");
            return;
        }

        this.updateStatus(`Downloading ${modelsWithUrls.length} model(s)...`, "info");

        // Download sequentially
        for (const model of modelsWithUrls) {
            if (model._downloadButton && !model._downloadButton.disabled) {
                await this.downloadModel(
                    model,
                    model._progressBar,
                    model._statusText,
                    model._downloadButton
                );

                // Wait a bit between downloads to avoid overwhelming the connection
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
    }

    updateStatus(message, type = "info") {
        const colors = {
            info: '#6c9',
            success: '#6c9',
            warning: '#fa4',
            error: '#f44'
        };

        this.statusElement.innerHTML = '';
        this.statusElement.appendChild(
            $el("span", {
                textContent: message,
                style: {
                    color: colors[type] || '#aaa'
                }
            })
        );
    }

    show() {
        this.element.style.display = "block";
        // Fade in animation
        setTimeout(() => {
            this.element.style.opacity = "1";
        }, 10);
        // Automatically scan workflow when dialog opens
        this.scanWorkflow();
    }

    close() {
        // Fade out animation
        this.element.style.opacity = "0";
        setTimeout(() => {
            this.element.style.display = "none";
        }, 300);

        // Stop all downloads
        this.downloadingModels.forEach(modelName => {
            api.fetchApi('/download-missing/cancel', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model_name: modelName })
            }).catch(err => console.error("Error cancelling download:", err));
        });
        this.downloadingModels.clear();
    }
}

// Global instances
let dialog = null;
let buttonGroup = null;

// Add CSS animations
const style = document.createElement('style');
style.textContent = `
    @keyframes progressPulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.8; }
    }

    .progress-downloading {
        animation: progressPulse 1.5s ease-in-out infinite;
    }
`;
document.head.appendChild(style);

// Add button to ComfyUI menu
function addDownloadMissingButton() {
    try {
        // Remove existing button group if it exists
        if (buttonGroup && buttonGroup.element?.parentElement) {
            buttonGroup.element.parentElement.removeChild(buttonGroup.element);
            buttonGroup = null;
        }

        // Create the button using ComfyButton
        const missingModelsButton = new ComfyButton({
            icon: "download",
            tooltip: "Download Missing Models",
            app,
            enabled: true,
            classList: "comfyui-button comfyui-menu-mobile-collapse",
            action: () => {
                if (!dialog) {
                    dialog = new MissingModelsDialog();
                }
                dialog.show();
            }
        });

        // Create button group
        buttonGroup = new ComfyButtonGroup(missingModelsButton);

        // Add to top bar - try to place it before the settings group
        if (app.menu?.settingsGroup?.element) {
            app.menu.settingsGroup.element.before(buttonGroup.element);
            console.log("[Missing Models] Button added to top bar before settings");
        } else {
            // Fallback: try to find the top bar and add it there
            const topBar = document.querySelector(".comfy-menu");
            if (topBar) {
                topBar.appendChild(buttonGroup.element);
                console.log("[Missing Models] Button added to menu bar (fallback)");
            }
        }

        console.log("[Missing Models] Button successfully added");
    } catch (error) {
        console.error("[Missing Models] Error adding button:", error);
    }
}

// Register extension
app.registerExtension({
    name: "ComfyUI.DownloadMissingModels",

    async init() {
        console.log("[Missing Models] Extension init called");
    },

    async setup() {
        console.log("[Missing Models] Extension setup called");
        // Add button after UI is ready
        setTimeout(() => {
            console.log("[Missing Models] Adding button...");
            addDownloadMissingButton();
        }, 1000);
    }
});

console.log("[Missing Models] Extension script loaded");
