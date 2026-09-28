// Copyright 2026 cloudflare-postgres contributors
// SPDX-License-Identifier: Apache-2.0

package certificatesigningrequest

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"net"
	"strings"
	"testing"

	"go.uber.org/zap"
	authorizationv1 "k8s.io/api/authorization/v1"
	certificatesv1 "k8s.io/api/certificates/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	k8sfake "k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"
	"k8s.io/client-go/tools/record"
	ctrl "sigs.k8s.io/controller-runtime"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"
	ctrlfake "sigs.k8s.io/controller-runtime/pkg/client/fake"
)

const (
	testNodeName = "node-one"
	testNodeUID  = "b3de1faa-ea20-4558-9497-34bd65d220b2"
)

// This workflow proves that the same reconciler accepts both issuance and renewal,
// while rejecting a request to impersonate an address outside that node's enrollment.
func TestEnrolledNodeRenewalRejectsForeignSAN(t *testing.T) {
	initial := signedRequest(t, "initial", testNodeName, "192.0.2.10")
	renewal := signedRequest(t, "renewal", testNodeName, "192.0.2.10")
	foreign := signedRequest(t, "foreign", testNodeName, "192.0.2.99")
	r, approvals := reconcilerFixture(t, testNodeUID, initial, renewal, foreign)

	reconcileRequest(t, r, initial.Name)
	reconcileRequest(t, r, renewal.Name)
	if *approvals != 2 {
		t.Fatalf("initial issuance and renewal should both be approved, got %d approvals", *approvals)
	}

	reconcileRequest(t, r, foreign.Name)
	if *approvals != 2 {
		t.Fatalf("foreign IP SAN was approved: total approvals = %d, want 2", *approvals)
	}
}

func TestRejectsUnenrolledRequester(t *testing.T) {
	request := signedRequest(t, "unenrolled", "node-other", "192.0.2.10")
	r, approvals := reconcilerFixture(t, testNodeUID, request)
	reconcileRequest(t, r, request.Name)
	if *approvals != 0 {
		t.Fatalf("unenrolled node requester was approved: approvals = %d, want 0", *approvals)
	}
}

func TestRejectsReplacedNodeEnrollment(t *testing.T) {
	request := signedRequest(t, "replaced", testNodeName, "192.0.2.10")
	r, approvals := reconcilerFixture(t, testNodeUID, request)
	var ambiguousEnrollment string
	// Recreate the Node during SAR, after the initial enrollment authorization.
	// The final approval must observe the changed identity rather than its old snapshot.
	r.ClientSet.(*k8sfake.Clientset).PrependReactor("create", "subjectaccessreviews", func(k8stesting.Action) (bool, runtime.Object, error) {
		old := &corev1.Node{ObjectMeta: metav1.ObjectMeta{Name: testNodeName}}
		if err := r.Client.Delete(context.Background(), old); err != nil {
			t.Fatal(err)
		}
		replacement := &corev1.Node{ObjectMeta: metav1.ObjectMeta{Name: testNodeName, UID: "609a761b-4d39-4923-99fa-603272a70939"}}
		if err := r.Client.Create(context.Background(), replacement); err != nil {
			t.Fatal(err)
		}
		var enrollment corev1.ConfigMap
		if err := r.Client.Get(context.Background(), ctrlclient.ObjectKey{Namespace: "operator", Name: "enrollment"}, &enrollment); err != nil {
			t.Fatal(err)
		}
		ambiguousEnrollment = strings.Replace(enrollment.Data["enrollment.json"], `"nodes":`, `"nodes":[],"nodes":`, 1)
		enrollment.Data["enrollment.json"] = ambiguousEnrollment
		if err := r.Client.Update(context.Background(), &enrollment); err != nil {
			t.Fatal(err)
		}
		return true, &authorizationv1.SubjectAccessReview{Status: authorizationv1.SubjectAccessReviewStatus{Allowed: true}}, nil
	})
	_, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: types.NamespacedName{Name: request.Name}})
	if err != nil && !strings.Contains(err.Error(), "duplicate JSON member") {
		t.Fatal(err)
	}
	if *approvals != 0 {
		t.Errorf("authority changed during SAR but was approved: approvals = %d, want 0", *approvals)
	}
	if ambiguousEnrollment == "" {
		t.Fatal("the authority transition during SAR did not execute")
	}
	if _, err := parseEnrollment([]byte(ambiguousEnrollment)); err == nil {
		t.Error("the enrollment authority transition accepted duplicate JSON members")
	}
}

func signedRequest(t *testing.T, name, node, address string) *certificatesv1.CertificateSigningRequest {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{
		Subject:     pkix.Name{CommonName: "system:node:" + node, Organization: []string{"system:nodes"}},
		DNSNames:    []string{node},
		IPAddresses: []net.IP{net.ParseIP(address)},
	}, key)
	if err != nil {
		t.Fatal(err)
	}
	return &certificatesv1.CertificateSigningRequest{
		ObjectMeta: metav1.ObjectMeta{Name: name, UID: types.UID("csr-" + name)},
		Spec: certificatesv1.CertificateSigningRequestSpec{
			Request:    pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: der}),
			SignerName: certificatesv1.KubeletServingSignerName,
			Username:   "system:node:" + node,
			Groups:     []string{"system:nodes", "system:authenticated"},
			Usages:     []certificatesv1.KeyUsage{certificatesv1.UsageDigitalSignature, certificatesv1.UsageServerAuth},
		},
	}
}

func reconcilerFixture(t *testing.T, currentNodeUID string, requests ...*certificatesv1.CertificateSigningRequest) (*SigningReconciler, *int) {
	t.Helper()
	scheme := runtime.NewScheme()
	if err := corev1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	if err := certificatesv1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	enrollment, err := json.Marshal(map[string]any{
		"apiVersion": "pgcf.io/kubelet-serving-enrollment/v1",
		"nodes": []map[string]any{{
			"name": testNodeName, "uid": testNodeUID,
			"dnsNames": []string{testNodeName}, "ipAddresses": []string{"192.0.2.10"},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	objects := []ctrlclient.Object{
		&corev1.Node{ObjectMeta: metav1.ObjectMeta{Name: testNodeName, UID: types.UID(currentNodeUID)}},
		&corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: "enrollment", Namespace: "operator", UID: "operator-enrollment"}, Data: map[string]string{"enrollment.json": string(enrollment)}},
	}
	for _, request := range requests {
		objects = append(objects, request)
	}
	client := ctrlfake.NewClientBuilder().WithScheme(scheme).WithObjects(objects...).Build()
	clientset := k8sfake.NewClientset()
	approvals := 0
	clientset.PrependReactor("create", "subjectaccessreviews", func(action k8stesting.Action) (bool, runtime.Object, error) {
		return true, &authorizationv1.SubjectAccessReview{Status: authorizationv1.SubjectAccessReviewStatus{Allowed: true}}, nil
	})
	clientset.PrependReactor("update", "certificatesigningrequests", func(action k8stesting.Action) (bool, runtime.Object, error) {
		if action.GetSubresource() != "approval" {
			t.Fatalf("unexpected CSR mutation: %s", action.GetSubresource())
		}
		approvals++
		request := action.(k8stesting.UpdateAction).GetObject()
		return true, request, nil
	})
	return &SigningReconciler{
		Client: client, APIReader: getOnlyReader{reader: client}, ClientSet: clientset,
		EnrollmentNamespace: "operator", EnrollmentConfigMap: "enrollment",
		Scheme: scheme, EventRecorder: record.NewFakeRecorder(10), Logger: zap.NewNop(),
	}, &approvals
}

type getOnlyReader struct{ reader ctrlclient.Reader }

func (r getOnlyReader) Get(ctx context.Context, key ctrlclient.ObjectKey, obj ctrlclient.Object, opts ...ctrlclient.GetOption) error {
	return r.reader.Get(ctx, key, obj, opts...)
}

func (r getOnlyReader) List(context.Context, ctrlclient.ObjectList, ...ctrlclient.ListOption) error {
	panic("enrollment authorization must never list/watch Node or ConfigMap resources")
}

func reconcileRequest(t *testing.T, r *SigningReconciler, name string) {
	t.Helper()
	_, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: types.NamespacedName{Name: name}})
	if err != nil {
		t.Fatal(err)
	}
}
