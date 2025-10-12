// Enable detailed logging for debugging (can be disabled later)
const DEBUG_LOGGING = false;

function debugLog(message) {
    if (DEBUG_LOGGING) {
        console.log(`[MissingModelsFinder] ${message}`);
    }
}

// Set a global variable to indicate the extension is loaded
window.MissingModelsFinderLoaded = true;

import { api } from "../../scripts/api.js";
import { app } from "../../scripts/app.js";
import { $el, ComfyDialog } from "../../scripts/ui.js";

// Import ComfyUI button components for top bar integration
import { ComfyButton } from "../../scripts/ui/components/button.js";
import { ComfyButtonGroup } from "../../scripts/ui/components/buttonGroup.js";

class MissingModelsDialog extends ComfyDialog {
    constructor() {
        super();
        this.missingModels = [];
        this.isAnalyzing = false;
        this.downloadProgress = {}; // Track download progress for each model
        this.websocket = null;
        this.setupWebSocket();
        
        this.element = $el("div.comfy-modal", {
            id: 'missing-models-dialog',
            parent: document.body,
            style: {
                width: '1000px',
                height: '700px',
                zIndex: 1000
            }
        }, [
            this.createContent()
        ]);
    }
    
    setupWebSocket() {
        try {
            // Get the current protocol and host
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const host = window.location.host;
            const wsUrl = `${protocol}//${host}/missing-models/ws`;
            
            this.websocket = new WebSocket(wsUrl);
            
            this.websocket.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    
                    if (data.type === 'download_progress') {
                        this.handleDownloadProgress(data.data);
                    }
                } catch (error) {
                    debugLog(`Error parsing WebSocket message: ${error}`);
                }
            };
            
            this.websocket.onclose = () => {
                // Attempt to reconnect after a delay
                setTimeout(() => {
                    this.setupWebSocket();
                }, 5000);
            };
            
        } catch (error) {
            debugLog(`Failed to setup WebSocket: ${error}`);
        }
    }
    
    handleDownloadProgress(progressData) {
        const { model_name, progress, downloaded, total, status, error } = progressData;
        
        // Update progress tracking
        this.downloadProgress[model_name] = progressData;
        
        // Update UI
        this.updateDownloadProgressUI(model_name, progressData);
        
        // Update status message for active downloads
        if (status === 'downloading' || status === 'starting') {
            this.updateStatus(`Downloading ${model_name}...`, 'info');
        } else if (status === 'queued') {
            this.updateStatus(`Queued: ${model_name} - waiting for previous download to complete`, 'info');
        } else if (status === 'completed') {
            this.updateStatus(`Download completed: ${model_name}`, 'success');
        } else if (status === 'error') {
            this.updateStatus(`Download failed: ${model_name} - ${error}`, 'error');
        }
    }
    
    formatBytes(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }
    
    truncateUrl(url, maxLength = 50) {
        if (!url || url.length <= maxLength) return url;
        
        // Try to keep the domain, first path element (user/org), and filename visible
        try {
            const urlObj = new URL(url);
            const pathname = urlObj.pathname;
            const pathParts = pathname.split('/').filter(part => part.length > 0);
            const filename = pathParts.pop();
            
            if (pathParts.length > 0 && filename) {
                const domain = urlObj.hostname;
                const firstPathElement = pathParts[0]; // This is typically the HuggingFace user/organization
                
                // Show domain + user + ... + filename
                const shortFilename = filename.length > 15 ? 
                    filename.substring(0, 12) + '...' :
                    filename;
                
                const truncated = `${domain}/${firstPathElement}/.../${shortFilename}`;
                return truncated.length <= maxLength ? truncated : truncated.substring(0, maxLength - 3) + '...';
            }
        } catch (e) {
            // If URL parsing fails, use simple truncation
        }
        
        // Simple truncation as fallback
        return url.substring(0, maxLength - 3) + '...';
    }
    
    setupResizableColumns() {
        const table = document.querySelector('#missing-models-dialog table');
        if (!table) {
            return;
        }
        
        const headers = table.querySelectorAll('th:not(:last-child)');
        
        headers.forEach((header, index) => {
            let isResizing = false;
            let startX = 0;
            let startWidth = 0;
            
            const handleMouseDown = (e) => {
                // Only trigger resize if clicking on the divider area
                // Check if click is within 8px of the right edge
                const headerRect = header.getBoundingClientRect();
                const clickX = e.clientX;
                const rightEdge = headerRect.right;
                
                if (clickX < rightEdge - 8) {
                    return; // Click was not on the divider
                }
                
                isResizing = true;
                startX = e.clientX;
                startWidth = header.offsetWidth;
                header.classList.add('resizing');
                
                // Create overlay to capture mouse events
                const overlay = $el('div', {
                    className: 'resize-overlay'
                });
                document.body.appendChild(overlay);
                
                const handleMouseMove = (e) => {
                    if (!isResizing) return;
                    
                    const dx = e.clientX - startX;
                    const newWidth = Math.max(50, startWidth + dx); // Minimum width 50px
                    
                    // Update column width
                    header.style.width = newWidth + 'px';
                    
                    // Update all cells in this column
                    const rows = table.querySelectorAll('tr');
                    rows.forEach(row => {
                        const cells = row.querySelectorAll('td, th');
                        if (cells[index]) {
                            cells[index].style.width = newWidth + 'px';
                        }
                    });
                };
                
                const handleMouseUp = () => {
                    isResizing = false;
                    header.classList.remove('resizing');
                    
                    // Remove overlay
                    if (overlay && overlay.parentElement) {
                        overlay.parentElement.removeChild(overlay);
                    }
                    
                    // Remove event listeners
                    document.removeEventListener('mousemove', handleMouseMove);
                    document.removeEventListener('mouseup', handleMouseUp);
                };
                
                document.addEventListener('mousemove', handleMouseMove);
                document.addEventListener('mouseup', handleMouseUp);
                
                // Prevent default to avoid text selection
                e.preventDefault();
                e.stopPropagation();
            };
            
            header.addEventListener('mousedown', handleMouseDown);
        });
    }
    
    updateDownloadProgressUI(modelName, progressData) {
        // Find the table row for this model
        const table = document.querySelector('#results-area table');
        if (!table) {
            return;
        }
        
        const rows = table.querySelectorAll('tbody tr');
        
        for (const row of rows) {
            const modelCell = row.querySelector('td:first-child');
            if (modelCell && modelCell.textContent === modelName) {
                // Update the action cell with progress
                const actionCell = row.querySelector('td:last-child');
                if (actionCell) {
                    this.updateActionCell(actionCell, progressData);
                }
                break;
            }
        }
    }
    
    updateActionCell(actionCell, progressData) {
        const { status } = progressData;
        
        // Clear existing content
        actionCell.innerHTML = '';
        
        if (status === 'downloading' || status === 'starting') {
            // Show downloading indicator
            actionCell.appendChild($el("span", {
                textContent: "Downloading...",
                style: {
                    color: '#2196F3',
                    fontSize: '12px',
                    fontWeight: 'bold',
                    fontStyle: 'italic'
                }
            }));
        } else if (status === 'queued') {
            // Show queued indicator
            actionCell.appendChild($el("span", {
                textContent: "Queued",
                style: {
                    color: '#FF9800',
                    fontSize: '12px',
                    fontWeight: 'bold',
                    fontStyle: 'italic'
                }
            }));
        } else if (status === 'completed') {
            // Show completed indicator
            actionCell.appendChild($el("span", {
                textContent: "✓ Completed",
                style: {
                    color: '#4CAF50',
                    fontSize: '12px',
                    fontWeight: 'bold'
                }
            }));
        } else if (status === 'error') {
            // Show error indicator
            actionCell.appendChild($el("span", {
                textContent: "✗ Failed",
                style: {
                    color: '#f44336',
                    fontSize: '12px',
                    fontWeight: 'bold'
                }
            }));
        } else {
            // Show download button (default)
            actionCell.appendChild($el("button", {
                textContent: "Download",
                onclick: () => this.downloadModel(progressData),
                style: {
                    padding: '4px 8px',
                    backgroundColor: '#2196F3',
                    color: 'white',
                    border: 'none',
                    borderRadius: '3px',
                    cursor: 'pointer',
                    fontSize: '12px'
                }
            }));
        }
    }
    
    createContent() {
        return $el("div.comfy-modal-content", {
            style: {
                width: '100%',
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                padding: '20px',
                boxSizing: 'border-box'
            }
        }, [
            // Header
            $el("div", {
                style: {
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: '20px',
                    borderBottom: '1px solid #444',
                    paddingBottom: '10px'
                }
            }, [
                $el("h2", {
                    textContent: "Missing Models Finder",
                    style: {
                        margin: 0,
                        color: 'white'
                    }
                }),
                $el("button", {
                    textContent: "Close",
                    onclick: () => this.close(),
                    style: {
                        padding: '5px 15px',
                        backgroundColor: '#555',
                        color: 'white',
                        border: 'none',
                        borderRadius: '3px',
                        cursor: 'pointer'
                    }
                })
            ]),
            
            // Controls
            $el("div", {
                style: {
                    display: 'flex',
                    gap: '10px',
                    marginBottom: '20px'
                }
            }, [
                $el("button", {
                    id: 'analyze-button',
                    textContent: "Analyze Workflow",
                    onclick: () => this.analyzeWorkflow(),
                    style: {
                        padding: '8px 16px',
                        backgroundColor: '#4CAF50',
                        color: 'white',
                        border: 'none',
                        borderRadius: '3px',
                        cursor: 'pointer',
                        fontWeight: 'bold'
                    }
                }),
                $el("button", {
                    id: 'download-all-button',
                    textContent: "Download All Missing",
                    onclick: () => this.downloadAllMissing(),
                    disabled: true,
                    style: {
                        padding: '8px 16px',
                        backgroundColor: '#2196F3',
                        color: 'white',
                        border: 'none',
                        borderRadius: '3px',
                        cursor: 'pointer',
                        opacity: 0.5
                    }
                })
            ]),
            
            // Status area
            $el("div", {
                id: 'status-area',
                style: {
                    marginBottom: '20px',
                    minHeight: '20px'
                }
            }),
            
            // Results area
            $el("div", {
                id: 'results-area',
                style: {
                    flex: 1,
                    overflow: 'auto',
                    border: '1px solid #444',
                    borderRadius: '3px',
                    padding: '10px',
                    backgroundColor: '#2a2a2a'
                }
            }, [
                $el("div", {
                    id: 'no-results-message',
                    textContent: "Click 'Analyze Workflow' to find missing models",
                    style: {
                        textAlign: 'center',
                        color: '#888',
                        fontStyle: 'italic',
                        padding: '20px'
                    }
                })
            ])
        ]);
    }
    
    async analyzeWorkflow() {
        this.isAnalyzing = true;
        this.updateStatus("Analyzing workflow for missing models...", 'info');
        
        const analyzeButton = document.getElementById('analyze-button');
        const downloadAllButton = document.getElementById('download-all-button');
        
        analyzeButton.disabled = true;
        analyzeButton.textContent = "Analyzing...";
        
        try {
            // Get the current workflow data from the app
            const workflowData = app.graph.serialize();
            
            const response = await api.fetchApi('/missing-models/analyze', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    workflow: workflowData
                })
            });
            
            if (response.ok) {
                const result = await response.json();
                this.missingModels = result.missing_models || [];
                
                if (this.missingModels.length > 0) {
                    this.updateStatus(`Found ${this.missingModels.length} missing models`, 'success');
                    this.displayResults();
                    downloadAllButton.disabled = false;
                    downloadAllButton.style.opacity = 1;
                } else {
                    this.updateStatus("No missing models found! All required models are installed.", 'success');
                    this.clearResults();
                    downloadAllButton.disabled = true;
                    downloadAllButton.style.opacity = 0.5;
                }
            } else {
                const error = await response.json();
                this.updateStatus(`Error: ${error.error || 'Failed to analyze workflow'}`, 'error');
                this.clearResults();
            }
            
        } catch (error) {
            this.updateStatus(`Error: ${error.message}`, 'error');
            this.clearResults();
        } finally {
            this.isAnalyzing = false;
            analyzeButton.disabled = false;
            analyzeButton.textContent = "Analyze Workflow";
        }
    }
    
    displayResults() {
        const resultsArea = document.getElementById('results-area');
        
        // Clear the results area completely
        this.clearResults();
        
        // Hide the no-results message
        const noResultsMessage = document.getElementById('no-results-message');
        if (noResultsMessage) {
            noResultsMessage.style.display = 'none';
        }
        
        // Create results table
        const table = $el("table", {}, [
            // Table header
            $el("thead", {}, [
                $el("tr", {}, [
                    $el("th", { textContent: "Model", style: { width: '25%' } }),
                    $el("th", { textContent: "Directory", style: { width: '15%' } }),
                    $el("th", { textContent: "URL", style: { width: '45%' } }),
                    $el("th", { textContent: "Action", style: { width: '15%' } })
                ])
            ]),
            // Table body
            $el("tbody", {}, 
                this.missingModels.map(model => 
                    $el("tr", { 
                        key: model.name
                    }, [
                        $el("td", { 
                            textContent: model.name,
                            title: model.name  // Show full name on hover
                        }),
                        $el("td", { 
                            textContent: model.directory,
                            title: model.directory  // Show full directory on hover
                        }),
                        $el("td", { 
                            textContent: this.truncateUrl(model.url),
                            title: model.url  // Show full URL on hover
                        }),
                        $el("td", { 
                            className: 'action-cell'
                        }, [
                            $el("button", {
                                textContent: "Download",
                                onclick: () => this.downloadModel(model),
                                className: 'download-button'
                            })
                        ])
                    ])
                )
            )
        ]);
        
        resultsArea.appendChild(table);
        
        // Setup resizable columns after table is added to DOM
        setTimeout(() => {
            this.setupResizableColumns();
        }, 100);
    }
    
    clearResults() {
        const resultsArea = document.getElementById('results-area');
        const noResultsMessage = document.getElementById('no-results-message');
        
        // Clear all content
        resultsArea.innerHTML = '';
        
        // Re-add the no-results message
        if (noResultsMessage) {
            resultsArea.appendChild(noResultsMessage);
            noResultsMessage.style.display = 'block';
        } else {
            // Create the no-results message if it doesn't exist
            resultsArea.appendChild($el("div", {
                id: 'no-results-message',
                textContent: "Click 'Analyze Workflow' to find missing models",
                style: {
                    textAlign: 'center',
                    color: '#888',
                    fontStyle: 'italic',
                    padding: '20px'
                }
            }));
        }
    }
    
    updateStatus(message, type = 'info') {
        const statusArea = document.getElementById('status-area');
        
        let color = '#888'; // default info color
        if (type === 'success') color = '#4CAF50';
        if (type === 'error') color = '#f44336';
        if (type === 'warning') color = '#ff9800';
        
        statusArea.innerHTML = '';
        statusArea.appendChild($el("div", {
            textContent: message,
            style: {
                color: color,
                fontWeight: type === 'error' ? 'bold' : 'normal',
                padding: '5px 0'
            }
        }));
    }
    
    async downloadModel(model) {
        this.updateStatus(`Requesting download: ${model.name}...`, 'info');
        
        try {
            const downloadData = {
                name: model.name,
                url: model.url,
                directory: model.directory
            };
            
            const response = await api.fetchApi('/missing-models/download', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(downloadData)
            });
            
            if (response.ok) {
                const result = await response.json();
                
                // Check if download was queued
                if (result.status === 'queued') {
                    return result; // Return queued status
                }
                
                this.updateStatus(`Download completed: ${model.name}`, 'success');
                
                // Remove the model from the list after successful download initiation
                this.missingModels = this.missingModels.filter(m => m.name !== model.name);
                
                // Update the UI
                if (this.missingModels.length === 0) {
                    this.updateStatus("All missing models have been downloaded!", 'success');
                    this.clearResults();
                    const downloadAllButton = document.getElementById('download-all-button');
                    downloadAllButton.disabled = true;
                    downloadAllButton.style.opacity = 0.5;
                } else {
                    this.displayResults();
                }
                
                return result; // Return the result
            } else {
                const error = await response.json();
                this.updateStatus(`Failed to download ${model.name}: ${error.error}`, 'error');
                throw new Error(error.error || 'Download failed');
            }
            
        } catch (error) {
            this.updateStatus(`Error downloading ${model.name}: ${error.message}`, 'error');
        }
    }
    
    async downloadAllMissing() {
        if (this.missingModels.length === 0) {
            this.updateStatus("No missing models to download", 'warning');
            return;
        }
        
        this.updateStatus(`Starting batch download of ${this.missingModels.length} models...`, 'info');
        
        const downloadAllButton = document.getElementById('download-all-button');
        downloadAllButton.disabled = true;
        downloadAllButton.style.opacity = 0.5;
        
        let completedCount = 0;
        let failedCount = 0;
        
        // Initialize progress for all models
        for (const model of this.missingModels) {
            this.downloadProgress[model.name] = {
                progress: 0,
                status: 'queued',
                downloaded: 0,
                total: 0
            };
            this.updateDownloadProgressUI(model.name, this.downloadProgress[model.name]);
        }
        
        // Download models sequentially to avoid overwhelming the system
        for (let i = 0; i < this.missingModels.length; i++) {
            const model = this.missingModels[i];
            
            // Update status to show which model is being processed
            this.updateStatus(`Processing ${i + 1}/${this.missingModels.length}: ${model.name}`, 'info');
            
            try {
                const result = await this.downloadModel(model);
                
                // Check if the download was queued
                if (result && result.status === 'queued') {
                    // Don't increment counters for queued downloads
                    continue;
                }
                
                completedCount++;
                
                // Update overall progress
                const overallProgress = Math.round((completedCount + failedCount) / this.missingModels.length * 100);
                this.updateStatus(`Progress: ${overallProgress}% (${completedCount} completed, ${failedCount} failed)`, 'info');
                
                // Small delay between downloads
                await new Promise(resolve => setTimeout(resolve, 500));
            } catch (error) {
                failedCount++;
                
                // Update overall progress
                const overallProgress = Math.round((completedCount + failedCount) / this.missingModels.length * 100);
                this.updateStatus(`Progress: ${overallProgress}% (${completedCount} completed, ${failedCount} failed)`, 'info');
            }
        }
        
        this.updateStatus(`Batch download complete: ${completedCount} succeeded, ${failedCount} failed`, 'success');
    }
    
    show() {
        this.element.style.display = "block";
        // Reset state when showing
        this.missingModels = [];
        this.downloadProgress = {};
        this.clearResults();
        this.updateStatus("Ready to analyze workflow", 'info');
        
        const downloadAllButton = document.getElementById('download-all-button');
        downloadAllButton.disabled = true;
        downloadAllButton.style.opacity = 0.5;
        
        // Ensure WebSocket is connected
        if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) {
            this.setupWebSocket();
        }
    }
    
    close() {
        this.element.style.display = "none";
        // Clean up WebSocket connection
        if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
            this.websocket.close();
        }
    }
}

// Global instances
let missingModelsDialog = null;
let missingModelsButtonGroup = null;

// Function to add top bar button
function addMissingModelsTopBarButton() {
    // Remove existing button group if it exists
    if (missingModelsButtonGroup && missingModelsButtonGroup.element?.parentElement) {
        missingModelsButtonGroup.element.parentElement.removeChild(missingModelsButtonGroup.element);
        missingModelsButtonGroup = null;
    }
    
    // Create the button
    const missingModelsButton = new ComfyButton({
        icon: "download",
        tooltip: "Find Missing Models",
        app,
        enabled: true,
        classList: "comfyui-button comfyui-menu-mobile-collapse",
        action: () => {
            if (!missingModelsDialog) {
                missingModelsDialog = new MissingModelsDialog();
            }
            missingModelsDialog.show();
        }
    });
    
    // Create button group
    missingModelsButtonGroup = new ComfyButtonGroup(missingModelsButton);
    
    // Add to top bar - try to place it before the settings group
    if (app.menu?.settingsGroup?.element) {
        app.menu.settingsGroup.element.before(missingModelsButtonGroup.element);
    } else {
        // Fallback: try to find the top bar and add it there
        const topBar = document.querySelector(".comfy-menu");
        if (topBar) {
            topBar.appendChild(missingModelsButtonGroup.element);
        }
    }
}

// Function to register the extension
function registerExtension() {
    if (typeof app !== 'undefined' && app && typeof app.registerExtension === 'function') {
        app.registerExtension({
            name: "ComfyUI.MissingModelsFinder",
        
            init() {
                // Add CSS styles
                const style = document.createElement('style');
                style.textContent = `
                    #missing-models-dialog {
                        background-color: #2a2a2a;
                        border: 1px solid #444;
                        border-radius: 5px;
                        box-shadow: 0 4px 6px rgba(0, 0, 0, 0.3);
                    }
                    
                    #missing-models-dialog .comfy-modal-content {
                        background-color: #2a2a2a;
                        color: white;
                    }
                    
                    #missing-models-dialog table {
                        width: 100%;
                        table-layout: fixed;
                        font-size: 11px;
                        border-collapse: collapse;
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
                    }
                    
                    #missing-models-dialog th {
                        background-color: #333;
                        font-weight: bold;
                        padding: 6px;
                        border-bottom: 1px solid #444;
                        text-align: left;
                        position: relative;
                        user-select: none;
                    }
                    
                    #missing-models-dialog th:not(:last-child)::after {
                        content: '';
                        position: absolute;
                        right: -2px; /* Extend beyond the column edge for easier clicking */
                        top: 0;
                        bottom: 0;
                        width: 8px; /* Wider for easier targeting */
                        cursor: col-resize;
                        background-color: transparent;
                        transition: background-color 0.2s;
                        z-index: 1;
                    }
                    
                    #missing-models-dialog th:not(:last-child):hover::after {
                        background-color: #666;
                    }
                    
                    #missing-models-dialog th.resizing::after {
                        background-color: #2196F3 !important;
                    }
                    
                    #missing-models-dialog td {
                        padding: 6px;
                        border-bottom: 1px solid #333;
                        overflow: hidden;
                        text-overflow: ellipsis;
                        white-space: nowrap;
                    }
                    
                    #missing-models-dialog tr:hover {
                        background-color: #333;
                    }
                    

                    
                    #missing-models-dialog .action-cell {
                        text-align: center;
                    }
                    
                    #missing-models-dialog .download-button {
                        padding: 3px 6px;
                        background-color: #2196F3;
                        color: white;
                        border: none;
                        border-radius: 3px;
                        cursor: pointer;
                        font-size: 10px;
                    }
                    
                    #missing-models-dialog .download-button:hover {
                        background-color: #1976D2;
                    }
                    
                    #missing-models-dialog .download-button:disabled {
                        background-color: #666;
                        cursor: not-allowed;
                    }
                    
                    #missing-models-dialog .resize-overlay {
                        position: fixed;
                        top: 0;
                        left: 0;
                        right: 0;
                        bottom: 0;
                        z-index: 10000;
                        cursor: col-resize;
                        user-select: none;
                        -webkit-user-select: none;
                        -moz-user-select: none;
                        -ms-user-select: none;
                    }
                    
                    #missing-models-dialog th {
                        user-select: none;
                        -webkit-user-select: none;
                        -moz-user-select: none;
                        -ms-user-select: none;
                    }
                `;
                document.head.appendChild(style);
            },
    
            async setup() {
                // Wait a bit for the top bar to be fully initialized
                setTimeout(() => {
                    addMissingModelsTopBarButton();
                }, 1000);
            }
        });
    }
}

// Call the registration function
registerExtension();

// Add a global function for testing
window.testMissingModelsFinder = function() {
    if (!missingModelsDialog) {
        missingModelsDialog = new MissingModelsDialog();
    }
    missingModelsDialog.show();
    return "Missing Models Finder dialog shown";
};