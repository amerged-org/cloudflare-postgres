// Copyright 2026 cloudflare-postgres contributors
// SPDX-License-Identifier: Apache-2.0

package certificatesigningrequest

import (
	"bytes"
	"context"
	"crypto/x509"
	"encoding/asn1"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/netip"
	"strings"

	certificatesv1 "k8s.io/api/certificates/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/validation"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"
)

const (
	enrollmentVersion = "pgcf.io/kubelet-serving-enrollment/v1"
	enrollmentKey     = "enrollment.json"
)

type enrollmentDocument struct {
	APIVersion string         `json:"apiVersion"`
	Nodes      []enrolledNode `json:"nodes"`
}

type enrolledNode struct {
	Name        string   `json:"name"`
	UID         string   `json:"uid"`
	DNSNames    []string `json:"dnsNames"`
	IPAddresses []string `json:"ipAddresses"`
}

type enrollmentSnapshot struct {
	ConfigMapUID             types.UID
	ConfigMapResourceVersion string
	NodeUID                  types.UID
	NodeResourceVersion      string
}

// authorizeEnrollment reads current operator enrollment and Node identity directly.
// Node status addresses are intentionally not an authority for issuing certificates.
func (r *SigningReconciler) authorizeEnrollment(ctx context.Context, csr *certificatesv1.CertificateSigningRequest, request *x509.CertificateRequest, snapshot *enrollmentSnapshot) (bool, string, error) {
	if r.APIReader == nil || r.EnrollmentNamespace == "" || r.EnrollmentConfigMap == "" {
		return false, "", errors.New("enrollment reader and ConfigMap namespace/name must be configured")
	}
	if !exactNodeGroups(csr.Spec.Groups) || !exactNodeSubject(request) {
		return false, "requester groups or certificate subject are not the exact kubelet identity", nil
	}
	if len(request.IPAddresses) == 0 {
		return false, "a serving request must contain at least one enrolled IP SAN", nil
	}
	var configMap corev1.ConfigMap
	if err := r.APIReader.Get(ctx, ctrlclient.ObjectKey{Namespace: r.EnrollmentNamespace, Name: r.EnrollmentConfigMap}, &configMap); err != nil {
		return false, "", fmt.Errorf("read operator enrollment: %w", err)
	}
	if configMap.UID == "" || configMap.ResourceVersion == "" || !configMap.DeletionTimestamp.IsZero() {
		return false, "", errors.New("operator enrollment must have an active API identity and resource version")
	}
	document, err := parseEnrollment([]byte(configMap.Data[enrollmentKey]))
	if err != nil {
		return false, "", fmt.Errorf("invalid operator enrollment: %w", err)
	}
	nodeName := strings.TrimPrefix(csr.Spec.Username, "system:node:")
	var enrolled *enrolledNode
	for i := range document.Nodes {
		if document.Nodes[i].Name == nodeName {
			enrolled = &document.Nodes[i]
			break
		}
	}
	if enrolled == nil {
		return false, "requester is not an enrolled node", nil
	}
	var node corev1.Node
	if err := r.APIReader.Get(ctx, ctrlclient.ObjectKey{Name: nodeName}, &node); err != nil {
		return false, "", fmt.Errorf("read enrolled Node: %w", err)
	}
	if string(node.UID) != enrolled.UID || node.ResourceVersion == "" || !node.DeletionTimestamp.IsZero() {
		return false, "live Node UID does not match active operator enrollment", nil
	}
	allowedDNS := make(map[string]bool, len(enrolled.DNSNames))
	for _, name := range enrolled.DNSNames {
		allowedDNS[name] = true
	}
	requestedDNS := make(map[string]bool, len(request.DNSNames))
	for _, name := range request.DNSNames {
		if !allowedDNS[name] || requestedDNS[name] {
			return false, "request contains a duplicate or unapproved DNS SAN", nil
		}
		requestedDNS[name] = true
	}
	allowedIPs := make(map[netip.Addr]bool, len(enrolled.IPAddresses))
	for _, address := range enrolled.IPAddresses {
		ip, _ := netip.ParseAddr(address) // parseEnrollment already validated every address.
		allowedIPs[ip.Unmap()] = true
	}
	requestedIPs := make(map[netip.Addr]bool, len(request.IPAddresses))
	for _, ip := range request.IPAddresses {
		address, valid := netip.AddrFromSlice(ip)
		address = address.Unmap()
		if !valid || !allowedIPs[address] || requestedIPs[address] {
			return false, "request contains a duplicate or unapproved IP SAN", nil
		}
		requestedIPs[address] = true
	}
	*snapshot = enrollmentSnapshot{
		ConfigMapUID:             configMap.UID,
		ConfigMapResourceVersion: configMap.ResourceVersion,
		NodeUID:                  node.UID,
		NodeResourceVersion:      node.ResourceVersion,
	}
	return true, "", nil
}

func exactNodeGroups(groups []string) bool {
	return len(groups) == 2 && ((groups[0] == "system:nodes" && groups[1] == "system:authenticated") ||
		(groups[1] == "system:nodes" && groups[0] == "system:authenticated"))
}

func exactNodeSubject(request *x509.CertificateRequest) bool {
	// The upstream conformance check already requires the exact CN and organization.
	// Reject additional or repeated subject attributes, including unknown OIDs.
	if len(request.Subject.Names) != 2 {
		return false
	}
	commonName, organization := false, false
	for _, name := range request.Subject.Names {
		switch {
		case name.Type.Equal(asn1.ObjectIdentifier{2, 5, 4, 3}):
			if commonName {
				return false
			}
			commonName = true
		case name.Type.Equal(asn1.ObjectIdentifier{2, 5, 4, 10}):
			if organization {
				return false
			}
			organization = true
		default:
			return false
		}
	}
	return commonName && organization
}

func parseEnrollment(data []byte) (*enrollmentDocument, error) {
	if err := rejectDuplicateJSONMembers(json.NewDecoder(bytes.NewReader(data))); err != nil {
		return nil, err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var document enrollmentDocument
	if err := decoder.Decode(&document); err != nil {
		return nil, err
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return nil, errors.New("enrollment must contain exactly one JSON document")
	}
	if document.APIVersion != enrollmentVersion || document.Nodes == nil {
		return nil, errors.New("enrollment version and nodes array are required")
	}
	names, uids := map[string]bool{}, map[string]bool{}
	dnsOwners, ipOwners := map[string]string{}, map[netip.Addr]string{}
	for _, node := range document.Nodes {
		if len(validation.IsDNS1123Subdomain(node.Name)) != 0 || node.UID == "" || strings.TrimSpace(node.UID) != node.UID || names[node.Name] || uids[node.UID] {
			return nil, errors.New("enrollment requires unique valid node names and nonempty unique UIDs")
		}
		names[node.Name], uids[node.UID] = true, true
		if len(node.IPAddresses) == 0 {
			return nil, errors.New("each enrolled node requires approved IP addresses")
		}
		for _, name := range node.DNSNames {
			if len(validation.IsDNS1123Subdomain(name)) != 0 || dnsOwners[name] != "" {
				return nil, errors.New("approved DNS names must be valid, unique and owned by one node")
			}
			dnsOwners[name] = node.Name
		}
		for _, address := range node.IPAddresses {
			ip, err := netip.ParseAddr(address)
			if err != nil || ip.Zone() != "" || ipOwners[ip.Unmap()] != "" {
				return nil, errors.New("approved IP addresses must be literal, unique and owned by one node")
			}
			ipOwners[ip.Unmap()] = node.Name
		}
	}
	return &document, nil
}

// Standard decoder tokens expose object members before struct decoding could
// silently overwrite an earlier authority value with a later duplicate key.
func rejectDuplicateJSONMembers(decoder *json.Decoder) error {
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	delimiter, composite := token.(json.Delim)
	if !composite {
		return nil
	}
	switch delimiter {
	case '{':
		seen := map[string]bool{}
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return err
			}
			key, valid := keyToken.(string)
			if !valid {
				return errors.New("JSON member name must be a string")
			}
			if seen[key] {
				return fmt.Errorf("duplicate JSON member %q", key)
			}
			seen[key] = true
			if err := rejectDuplicateJSONMembers(decoder); err != nil {
				return err
			}
		}
	case '[':
		for decoder.More() {
			if err := rejectDuplicateJSONMembers(decoder); err != nil {
				return err
			}
		}
	default:
		return errors.New("unexpected JSON delimiter")
	}
	_, err = decoder.Token()
	return err
}
