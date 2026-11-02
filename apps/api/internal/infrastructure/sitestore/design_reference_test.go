package sitestore

import "testing"

func TestDocumentMentionsAsset(t *testing.T) {
	doc := []byte(`{"home":{"blocks":[{"type":"image","props":{"src":"/api/v1/media/01HX9"}}]}}`)

	if !DocumentMentionsAsset(doc, "01HX9") {
		t.Fatal("asset id present in the document must be reported as referenced")
	}
	if DocumentMentionsAsset(doc, "01HX8") {
		t.Fatal("unknown asset id must not be reported as referenced")
	}
	if DocumentMentionsAsset(nil, "01HX9") {
		t.Fatal("an empty document references nothing")
	}
	if DocumentMentionsAsset(doc, "") {
		t.Fatal("an empty asset id references nothing")
	}
}
