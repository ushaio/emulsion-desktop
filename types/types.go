package types

// StorageSourceDTO is the Desktop storage source view model exposed to the frontend.
type StorageSourceDTO struct {
	ID           string            `json:"id"`
	Name         string            `json:"name"`
	Type         string            `json:"type"`
	Runtime      string            `json:"runtime,omitempty"`
	PluginID     string            `json:"pluginId,omitempty"`
	Local        bool              `json:"local,omitempty"`
	// PluginInstalled mirrors storage_plugins.SourceDTO.PluginInstalled: false
	// means the source outlived its plugin (uninstalling keeps sources so
	// reinstalling restores them). The settings page surfaces this so a source
	// that disappears from storage maintenance is explainable, not mysterious.
	PluginInstalled bool   `json:"pluginInstalled"`
	Enabled      bool              `json:"enabled"`
	Status       string            `json:"status,omitempty"`
	LastError    string            `json:"lastError,omitempty"`
	AccessKey    *string           `json:"accessKey,omitempty"`
	SecretKey    *string           `json:"secretKey,omitempty"`
	Bucket       *string           `json:"bucket,omitempty"`
	Region       *string           `json:"region,omitempty"`
	Endpoint     *string           `json:"endpoint,omitempty"`
	PublicURL    *string           `json:"publicUrl,omitempty"`
	BasePath     *string           `json:"basePath,omitempty"`
	Branch       *string           `json:"branch,omitempty"`
	AccessMethod *string           `json:"accessMethod,omitempty"`
	Config       map[string]string `json:"config,omitempty"`
}
