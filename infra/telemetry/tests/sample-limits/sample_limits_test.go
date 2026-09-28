// Copyright 2026 cloudflare-postgres contributors
// SPDX-License-Identifier: Apache-2.0

package samplelimits

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	monitoringv1 "github.com/prometheus-operator/prometheus-operator/pkg/apis/monitoring/v1"
	monitoringv1alpha1 "github.com/prometheus-operator/prometheus-operator/pkg/apis/monitoring/v1alpha1"
	"github.com/prometheus-operator/prometheus-operator/pkg/assets"
	operatorprometheus "github.com/prometheus-operator/prometheus-operator/pkg/prometheus"
	yamlv2 "gopkg.in/yaml.v2"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	utilyaml "k8s.io/apimachinery/pkg/util/yaml"
	sigsyaml "sigs.k8s.io/yaml"
)

const (
	observedAPISamples = int64(32254)
	defaultLimit       = int64(20000)
	apiLimit           = int64(40000)
	expectedJobs       = 14
)

// One workflow compares the actual selected render inputs through the maintained
// Operator generator. It does not reproduce the Operator's limit policy.
func TestAPIServerSampleLimitPreservesOtherJobs(t *testing.T) {
	directory := os.Getenv("PGCF_TELEMETRY_RENDER_DIR")
	if directory == "" {
		t.Fatal("PGCF_TELEMETRY_RENDER_DIR must identify the reviewed render inputs")
	}
	baseline := readRender(t, filepath.Join(directory, "baseline-render.yaml"))
	candidate := readRender(t, filepath.Join(directory, "candidate-render.yaml"))
	before := generatedLimits(t, baseline)
	after := generatedLimits(t, candidate)
	if before.global != defaultLimit || after.global != defaultLimit {
		t.Fatal("the emitted global default must remain 20000")
	}
	if len(before.jobs) != expectedJobs || len(after.jobs) != expectedJobs {
		t.Fatalf("expected the reviewed 14-job inventory, got baseline %d and candidate %d", len(before.jobs), len(after.jobs))
	}
	beforeAPI := apiServerJob(t, baseline)
	afterAPI := apiServerJob(t, candidate)
	if beforeAPI != afterAPI {
		t.Fatal("the API-server job identity changed")
	}
	if before.jobs[beforeAPI] != defaultLimit {
		t.Fatal("the baseline must reproduce the observed 20000 API-server cap")
	}
	if after.jobs[afterAPI] != apiLimit || after.jobs[afterAPI] <= observedAPISamples {
		t.Fatalf("API-server effective limit = %d; want finite 40000 above the observed 32254 samples", after.jobs[afterAPI])
	}
	for job, limit := range before.jobs {
		candidateLimit, exists := after.jobs[job]
		if !exists {
			t.Fatal("an existing generated job disappeared")
		}
		if job != beforeAPI && candidateLimit != limit {
			t.Fatal("a non-API job's effective sample limit changed")
		}
	}
}

type renderInputs struct {
	prometheus      *monitoringv1.Prometheus
	serviceMonitors map[string]*monitoringv1.ServiceMonitor
	podMonitors     map[string]*monitoringv1.PodMonitor
}

func readRender(t *testing.T, filename string) *renderInputs {
	t.Helper()
	input, err := os.ReadFile(filename)
	if err != nil {
		t.Fatalf("cannot read %s", filepath.Base(filename))
	}
	result := &renderInputs{
		serviceMonitors: map[string]*monitoringv1.ServiceMonitor{},
		podMonitors:     map[string]*monitoringv1.PodMonitor{},
	}
	reader := utilyaml.NewYAMLReader(bufio.NewReader(bytes.NewReader(input)))
	for {
		document, err := reader.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("cannot read YAML stream in %s", filepath.Base(filename))
		}
		data, err := sigsyaml.YAMLToJSONStrict(document)
		if err != nil {
			t.Fatalf("invalid or duplicate-key YAML in %s", filepath.Base(filename))
		}
		addRenderObject(t, result, data)
	}
	if result.prometheus == nil || len(result.serviceMonitors) == 0 || len(result.podMonitors) != 2 {
		t.Fatal("render must contain one Prometheus, selected ServiceMonitors and the two unchanged target PodMonitors")
	}
	if strings.TrimPrefix(result.prometheus.Spec.Version, "v") != "3.15.0-distroless" {
		t.Fatal("rendered Prometheus version must match the pinned 3.15.0-distroless declaration")
	}
	return result
}

func addRenderObject(t *testing.T, result *renderInputs, data []byte) {
	t.Helper()
	if len(bytes.TrimSpace(data)) == 0 || string(bytes.TrimSpace(data)) == "null" {
		return
	}
	var header struct {
		Kind  string            `json:"kind"`
		Items []json.RawMessage `json:"items"`
	}
	if json.Unmarshal(data, &header) != nil {
		t.Fatal("invalid rendered JSON object")
	}
	if header.Kind == "List" {
		for _, item := range header.Items {
			addRenderObject(t, result, item)
		}
		return
	}
	switch header.Kind {
	case "Prometheus":
		var object monitoringv1.Prometheus
		if json.Unmarshal(data, &object) != nil || result.prometheus != nil {
			t.Fatal("render must contain exactly one valid Prometheus object")
		}
		requireIdentity(t, object.ObjectMeta)
		result.prometheus = &object
	case "ServiceMonitor":
		var object monitoringv1.ServiceMonitor
		if json.Unmarshal(data, &object) != nil {
			t.Fatal("invalid rendered ServiceMonitor")
		}
		key := requireIdentity(t, object.ObjectMeta)
		if _, exists := result.serviceMonitors[key]; exists {
			t.Fatal("duplicate rendered ServiceMonitor identity")
		}
		result.serviceMonitors[key] = &object
	case "PodMonitor":
		var object monitoringv1.PodMonitor
		if json.Unmarshal(data, &object) != nil {
			t.Fatal("invalid rendered PodMonitor")
		}
		key := requireIdentity(t, object.ObjectMeta)
		if _, exists := result.podMonitors[key]; exists {
			t.Fatal("duplicate rendered PodMonitor identity")
		}
		result.podMonitors[key] = &object
	}
}

func requireIdentity(t *testing.T, metadata metav1.ObjectMeta) string {
	t.Helper()
	if metadata.Name == "" || metadata.Namespace == "" {
		t.Fatal("selected monitoring objects need explicit names and namespaces")
	}
	return metadata.Namespace + "/" + metadata.Name
}

type limitMap struct {
	global int64
	jobs   map[string]int64
}

func generatedLimits(t *testing.T, input *renderInputs) limitMap {
	t.Helper()
	var diagnostics bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&diagnostics, &slog.HandlerOptions{Level: slog.LevelWarn}))
	// The actual Operator has EndpointSlice discovery disabled. Default options
	// therefore reproduce its endpoints/pod discovery behavior.
	generator, err := operatorprometheus.NewConfigGenerator(logger, input.prometheus)
	if err != nil {
		t.Fatal("cannot create the pinned Operator configuration generator")
	}
	store := assets.NewStoreBuilder(nil, nil)
	if err := store.AddObject(&corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{Name: "kube-root-ca.crt", Namespace: "pgcf-monitoring"},
		Data:       map[string]string{"ca.crt": "offline-public-ca-placeholder"},
	}); err != nil {
		t.Fatal("cannot seed the offline public CA-reference cache")
	}
	seedAuthorizationReferences(t, store, input.serviceMonitors)
	configuration, err := generator.GenerateServerConfiguration(
		input.prometheus,
		input.serviceMonitors,
		input.podMonitors,
		map[string]*monitoringv1.Probe{},
		map[string]*monitoringv1alpha1.ScrapeConfig{},
		store,
		nil, nil, nil, nil,
	)
	if err != nil || diagnostics.Len() != 0 {
		t.Fatalf("Operator generation failed or emitted warnings/errors (%d diagnostic bytes): %s", diagnostics.Len(), diagnostics.String())
	}
	var parsed struct {
		Global struct {
			SampleLimit *int64 `yaml:"sample_limit"`
		} `yaml:"global"`
		Jobs []struct {
			Name        string `yaml:"job_name"`
			SampleLimit *int64 `yaml:"sample_limit"`
		} `yaml:"scrape_configs"`
	}
	if yamlv2.Unmarshal(configuration, &parsed) != nil || parsed.Global.SampleLimit == nil || *parsed.Global.SampleLimit <= 0 {
		t.Fatal("generator must emit a finite global sample limit")
	}
	result := limitMap{global: *parsed.Global.SampleLimit, jobs: map[string]int64{}}
	for _, job := range parsed.Jobs {
		if job.Name == "" {
			t.Fatal("generated job has no identity")
		}
		if _, exists := result.jobs[job.Name]; exists {
			t.Fatal("duplicate generated job identity")
		}
		// Read Prometheus YAML inheritance only: absent per-job configuration
		// inherits the emitted global field. No Operator clipping is duplicated.
		limit := result.global
		if job.SampleLimit != nil {
			limit = *job.SampleLimit
		}
		if limit <= 0 {
			t.Fatal("a generated job lost its finite sample limit")
		}
		result.jobs[job.Name] = limit
	}
	return result
}

// Authorization selectors are public rendered metadata. Their runtime Secret
// values are never read: cache-only dummy bytes enable configuration generation.
func seedAuthorizationReferences(t *testing.T, store *assets.StoreBuilder, monitors map[string]*monitoringv1.ServiceMonitor) {
	t.Helper()
	secrets := map[string]*corev1.Secret{}
	for _, monitor := range monitors {
		for _, endpoint := range monitor.Spec.Endpoints {
			if endpoint.Authorization == nil || endpoint.Authorization.Credentials == nil {
				continue
			}
			selector := endpoint.Authorization.Credentials
			if selector.Name == "" || selector.Key == "" {
				t.Fatal("rendered authorization credentials need a valid Secret name and key")
			}
			identity := monitor.Namespace + "/" + selector.Name
			secret := secrets[identity]
			if secret == nil {
				secret = &corev1.Secret{
					ObjectMeta: metav1.ObjectMeta{Name: selector.Name, Namespace: monitor.Namespace},
					Type:       corev1.SecretTypeOpaque,
					Data:       map[string][]byte{},
				}
				secrets[identity] = secret
			}
			secret.Data[selector.Key] = []byte("offline-public-authorization-placeholder")
		}
	}
	for _, secret := range secrets {
		if err := store.AddObject(secret); err != nil {
			t.Fatal("cannot seed the offline rendered authorization-reference cache")
		}
	}
}

func apiServerJob(t *testing.T, input *renderInputs) string {
	t.Helper()
	var match *monitoringv1.ServiceMonitor
	for _, monitor := range input.serviceMonitors {
		if monitor.Spec.Selector.MatchLabels["component"] == "apiserver" && monitor.Spec.Selector.MatchLabels["provider"] == "kubernetes" {
			if match != nil {
				t.Fatal("more than one selected API-server ServiceMonitor")
			}
			match = monitor
		}
	}
	if match == nil || len(match.Spec.Endpoints) != 1 {
		t.Fatal("expected the reviewed single-endpoint API-server ServiceMonitor")
	}
	return fmt.Sprintf("serviceMonitor/%s/%s/0", match.Namespace, match.Name)
}
