//! Pure provider schema construction for knowledge import contracts.

use super::MAX_ORGANIZED_ITEMS;
use serde_json::{json, Value};

pub(super) fn organizer_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "notes": {
                "type": "array",
                "maxItems": MAX_ORGANIZED_ITEMS,
                "description": "Distinct thesis-led notes within the shared 30-output atomic safety boundary; no separate project-note quota.",
                "items": {
                    "type": "object",
                    "properties": {
                        "title": {
                            "type": "string",
                            "description": "A concise, unique wiki note title."
                        },
                        "summary": {
                            "type": "string",
                            "description": "A one or two sentence preview of the note."
                        },
                        "body": {
                            "type": "string",
                            "description": "The complete note in readable Markdown. Use ordinary concept text, never [[wiki-link]] bracket syntax."
                        },
                        "tags": {
                            "type": "array",
                            "items": { "type": "string" }
                        },
                        "aliases": {
                            "type": "array",
                            "items": { "type": "string" }
                        },
                        "links": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "targetTitle": { "type": "string" },
                                    "context": { "type": "string" }
                                },
                                "required": ["targetTitle", "context"],
                                "additionalProperties": false
                            }
                        }
                    },
                    "required": ["title", "summary", "body", "tags", "aliases", "links"],
                    "additionalProperties": false
                }
            },
            "wikiArticles": {
                "type": "array",
                "maxItems": MAX_ORGANIZED_ITEMS,
                "description": "Canonical articles within the shared 30-output atomic safety boundary; create only distinct supported knowledge objects.",
                "items": {
                    "type": "object",
                    "properties": {
                        "title": {
                            "type": "string",
                            "description": "The canonical article title, such as SQL."
                        },
                        "summary": { "type": "string" },
                        "body": {
                            "type": "string",
                            "description": "The complete coherent wiki article in readable Markdown, integrating existing and new context without provenance headings."
                        },
                        "overview": {
                            "type": "string",
                            "description": "A concise, high-confidence general explanation."
                        },
                        "spaceRelevance": {
                            "type": "string",
                            "description": "Why this subject matters in the supplied Space."
                        },
                        "sourceGroundedDetails": {
                            "type": "array",
                            "items": { "type": "string" }
                        },
                        "uncertainties": {
                            "type": "array",
                            "items": { "type": "string" }
                        },
                        "tags": {
                            "type": "array",
                            "items": { "type": "string" }
                        },
                        "aliases": {
                            "type": "array",
                            "items": { "type": "string" }
                        },
                        "links": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "targetTitle": { "type": "string" },
                                    "context": { "type": "string" }
                                },
                                "required": ["targetTitle", "context"],
                                "additionalProperties": false
                            }
                        }
                    },
                    "required": [
                        "title", "summary", "body", "overview", "spaceRelevance",
                        "sourceGroundedDetails", "uncertainties", "tags",
                        "aliases", "links"
                    ],
                    "additionalProperties": false
                }
            },
            "concepts": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "label": {
                            "type": "string",
                            "description": "A specific reusable phrase that should become a hyperlink."
                        },
                        "aliases": {
                            "type": "array",
                            "items": { "type": "string" }
                        },
                        "description": { "type": "string" },
                        "canonicalTitle": {
                            "type": "string",
                            "description": "Exact title of this phrase's appropriate returned or existing canonical note or wiki article."
                        },
                        "relatedTitles": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "Exact contextual note titles related to the canonical article."
                        }
                    },
                    "required": [
                        "label", "aliases", "description", "canonicalTitle",
                        "relatedTitles"
                    ],
                    "additionalProperties": false
                }
            },
            "suggestedConnections": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "fromTitle": { "type": "string" },
                        "toTitle": { "type": "string" },
                        "kind": {
                            "type": "string",
                            "enum": ["supports", "qualifies", "conflicts", "related"]
                        },
                        "reason": { "type": "string" }
                    },
                    "required": ["fromTitle", "toTitle", "kind", "reason"],
                    "additionalProperties": false
                }
            }
        },
        "required": ["notes", "wikiArticles", "concepts", "suggestedConnections"],
        "additionalProperties": false
    })
}

pub(super) fn anthropic_organizer_schema() -> Value {
    let mut schema = organizer_schema();
    strip_anthropic_unsupported_schema_keywords(&mut schema);
    schema
}

pub(super) fn strip_anthropic_unsupported_schema_keywords(value: &mut Value) {
    match value {
        Value::Object(object) => {
            for keyword in [
                "minLength",
                "maxLength",
                "minItems",
                "maxItems",
                "minimum",
                "maximum",
            ] {
                object.remove(keyword);
            }
            for child in object.values_mut() {
                strip_anthropic_unsupported_schema_keywords(child);
            }
        }
        Value::Array(values) => {
            for child in values {
                strip_anthropic_unsupported_schema_keywords(child);
            }
        }
        _ => {}
    }
}

fn knowledge_reference_schema() -> Value {
    json!({
        "anyOf": [
            {
                "type": "object",
                "properties": {
                    "kind": { "type": "string", "const": "source" },
                    "sourceId": { "type": "string", "minLength": 1, "maxLength": 300 }
                },
                "required": ["kind", "sourceId"],
                "additionalProperties": false
            },
            {
                "type": "object",
                "properties": {
                    "kind": { "type": "string", "const": "source-range" },
                    "sourceId": { "type": "string", "minLength": 1, "maxLength": 300 },
                    "rangeId": { "type": "string", "minLength": 1, "maxLength": 300 }
                },
                "required": ["kind", "sourceId", "rangeId"],
                "additionalProperties": false
            },
            {
                "type": "object",
                "properties": {
                    "kind": { "type": "string", "const": "note-digest-range" },
                    "rangeId": { "type": "string", "minLength": 1, "maxLength": 300 }
                },
                "required": ["kind", "rangeId"],
                "additionalProperties": false
            },
            {
                "type": "object",
                "properties": {
                    "kind": { "type": "string", "const": "note" },
                    "noteId": { "type": "string", "minLength": 1, "maxLength": 300 },
                    "version": { "type": "string", "minLength": 1, "maxLength": 300 }
                },
                "required": ["kind", "noteId", "version"],
                "additionalProperties": false
            },
            {
                "type": "object",
                "properties": {
                    "kind": { "type": "string", "const": "concept" },
                    "conceptId": { "type": "string", "minLength": 1, "maxLength": 300 }
                },
                "required": ["kind", "conceptId"],
                "additionalProperties": false
            },
            {
                "type": "object",
                "properties": {
                    "kind": { "type": "string", "const": "artifact" },
                    "artifactId": { "type": "string", "minLength": 1, "maxLength": 300 }
                },
                "required": ["kind", "artifactId"],
                "additionalProperties": false
            }
        ]
    })
}

fn knowledge_string_array_schema(max_items: usize) -> Value {
    json!({
        "type": "array",
        "maxItems": max_items,
        "items": { "type": "string", "minLength": 1, "maxLength": 4_000 }
    })
}

fn knowledge_owner_proposal_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "destinationNoteId": { "type": "string", "minLength": 1, "maxLength": 300 },
            "baseVersion": { "type": "string", "minLength": 1, "maxLength": 300 },
            "title": { "type": "string", "minLength": 1, "maxLength": 300 },
            "summary": { "type": "string", "maxLength": 2_000 },
            "body": { "type": "string", "maxLength": 100_000 },
            "aliases": knowledge_string_array_schema(24),
            "tags": knowledge_string_array_schema(24),
            "sourceIds": {
                "type": "array",
                "maxItems": 24,
                "items": { "type": "string", "minLength": 1, "maxLength": 300 }
            }
        },
        "required": [
            "destinationNoteId", "baseVersion", "title", "summary", "body",
            "aliases", "tags", "sourceIds"
        ],
        "additionalProperties": false
    })
}

fn knowledge_source_range_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "sourceId": { "type": "string", "minLength": 1, "maxLength": 300 },
            "rangeId": { "type": "string", "minLength": 1, "maxLength": 300 }
        },
        "required": ["sourceId", "rangeId"],
        "additionalProperties": false
    })
}

fn knowledge_reading_blueprint_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "spaceExplanation": { "type": "string", "minLength": 1, "maxLength": 8_000 },
            "spaceFocusConcepts": knowledge_string_array_schema(40),
            "spaceQuestions": knowledge_string_array_schema(40),
            "readers": {
                "type": "array",
                "minItems": 1,
                "maxItems": 100,
                "items": {
                    "type": "object",
                    "properties": {
                        "readerId": { "type": "string", "minLength": 1, "maxLength": 300 },
                        "sourceId": { "type": "string", "minLength": 1, "maxLength": 300 },
                        "rangeId": { "type": "string", "minLength": 1, "maxLength": 300 },
                        "focusQuestions": knowledge_string_array_schema(40),
                        "focusConcepts": knowledge_string_array_schema(40),
                        "comparisons": {
                            "type": "array",
                            "maxItems": 40,
                            "items": {
                                "type": "object",
                                "properties": {
                                    "noteId": { "type": "string", "minLength": 1, "maxLength": 300 },
                                    "reason": { "type": "string", "minLength": 1, "maxLength": 2_000 }
                                },
                                "required": ["noteId", "reason"],
                                "additionalProperties": false
                            }
                        },
                        "mustPreserve": knowledge_string_array_schema(100)
                    },
                    "required": [
                        "readerId", "sourceId", "rangeId", "focusQuestions",
                        "focusConcepts", "comparisons", "mustPreserve"
                    ],
                    "additionalProperties": false
                }
            },
            "warnings": knowledge_string_array_schema(80)
        },
        "required": [
            "spaceExplanation", "spaceFocusConcepts", "spaceQuestions",
            "readers", "warnings"
        ],
        "additionalProperties": false
    })
}

fn knowledge_source_reading_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "sourceId": { "type": "string", "minLength": 1, "maxLength": 300 },
            "rangeId": { "type": "string", "minLength": 1, "maxLength": 300 },
            "summary": { "type": "string", "minLength": 1, "maxLength": 8_000 },
            "coverage": {
                "type": "object",
                "properties": {
                    "complete": { "type": "boolean" },
                    "limitations": knowledge_string_array_schema(40)
                },
                "required": ["complete", "limitations"],
                "additionalProperties": false
            },
            "sourceAssessment": {
                "type": "object",
                "properties": {
                    "importance": { "type": "string", "enum": ["low", "medium", "high"] },
                    "rationale": { "type": "string", "minLength": 1, "maxLength": 4_000 }
                },
                "required": ["importance", "rationale"],
                "additionalProperties": false
            },
            "spaceAssessment": {
                "type": "object",
                "properties": {
                    "relevance": { "type": "string", "enum": ["low", "medium", "high"] },
                    "novelty": { "type": "string", "enum": ["low", "medium", "high"] },
                    "focusConcepts": knowledge_string_array_schema(40),
                    "deprioritizedConcepts": knowledge_string_array_schema(40),
                    "reviewedNoteIds": {
                        "type": "array",
                        "maxItems": 100,
                        "items": { "type": "string", "minLength": 1, "maxLength": 300 }
                    },
                    "rationale": { "type": "string", "minLength": 1, "maxLength": 4_000 }
                },
                "required": [
                    "relevance", "novelty", "focusConcepts",
                    "deprioritizedConcepts", "reviewedNoteIds", "rationale"
                ],
                "additionalProperties": false
            },
            "sourceClaims": {
                "type": "array",
                "maxItems": 100,
                "items": {
                    "type": "object",
                    "properties": {
                        "claimId": { "type": "string", "minLength": 1, "maxLength": 300 },
                        "text": { "type": "string", "minLength": 1, "maxLength": 4_000 },
                        "support": {
                            "type": "array",
                            "minItems": 1,
                            "maxItems": 40,
                            "items": knowledge_source_range_schema()
                        }
                    },
                    "required": ["claimId", "text", "support"],
                    "additionalProperties": false
                }
            },
            "synthesisSeeds": {
                "type": "array",
                "maxItems": 100,
                "items": {
                    "type": "object",
                    "properties": {
                        "seedId": { "type": "string", "minLength": 1, "maxLength": 300 },
                        "proposedTitle": { "type": "string", "minLength": 1, "maxLength": 300 },
                        "thesis": { "type": "string", "minLength": 1, "maxLength": 4_000 },
                        "linkPhrases": {
                            "type": "array",
                            "maxItems": 8,
                            "items": { "type": "string", "minLength": 1, "maxLength": 120 },
                            "description": "Deliberate durable link phrases grounded in the thesis or exact selected claims; not a keyword inventory."
                        },
                        "claimIds": {
                            "type": "array",
                            "minItems": 1,
                            "maxItems": 4,
                            "items": { "type": "string", "minLength": 1, "maxLength": 300 }
                        },
                        "importance": { "type": "string", "enum": ["high", "medium", "low"] },
                        "contribution": {
                            "type": "string",
                            "enum": ["new", "extends", "contradicts", "connects", "qualifies"]
                        },
                        "relatedNoteIds": {
                            "type": "array",
                            "maxItems": 100,
                            "items": { "type": "string", "minLength": 1, "maxLength": 300 }
                        },
                        "rationale": { "type": "string", "minLength": 1, "maxLength": 4_000 }
                    },
                    "required": [
                        "seedId", "proposedTitle", "thesis", "claimIds", "importance",
                        "contribution", "relatedNoteIds", "linkPhrases", "rationale"
                    ],
                    "additionalProperties": false
                }
            },
            "spaceInterpretations": {
                "type": "array",
                "maxItems": 100,
                "items": {
                    "type": "object",
                    "properties": {
                        "interpretationId": { "type": "string", "minLength": 1, "maxLength": 300 },
                        "text": { "type": "string", "minLength": 1, "maxLength": 4_000 },
                        "sourceClaimIds": {
                            "type": "array",
                            "minItems": 1,
                            "maxItems": 100,
                            "items": { "type": "string", "minLength": 1, "maxLength": 300 }
                        },
                        "relatedNoteIds": {
                            "type": "array",
                            "maxItems": 100,
                            "items": { "type": "string", "minLength": 1, "maxLength": 300 }
                        },
                        "rationale": { "type": "string", "minLength": 1, "maxLength": 4_000 }
                    },
                    "required": [
                        "interpretationId", "text", "sourceClaimIds",
                        "relatedNoteIds", "rationale"
                    ],
                    "additionalProperties": false
                }
            },
            "mustPreserve": knowledge_string_array_schema(100)
        },
        "required": [
            "sourceId", "rangeId", "summary", "coverage", "sourceAssessment",
            "spaceAssessment", "sourceClaims", "synthesisSeeds", "spaceInterpretations",
            "mustPreserve"
        ],
        "additionalProperties": false
    })
}

fn knowledge_evidence_selection_schema(id_field: &str) -> Value {
    let mut properties = json!({
        "artifactId": { "type": "string", "minLength": 1, "maxLength": 300 }
    });
    properties
        .as_object_mut()
        .expect("properties is an object")
        .insert(
            id_field.to_string(),
            json!({
                "type": "array",
                "minItems": 1,
                "maxItems": 100,
                "items": { "type": "string", "minLength": 1, "maxLength": 300 }
            }),
        );
    json!({
        "type": "object",
        "properties": properties,
        "required": ["artifactId", id_field],
        "additionalProperties": false
    })
}

fn knowledge_existing_destination_schema() -> Value {
    json!({
        "anyOf": [
            { "type": "null" },
            {
                "type": "object",
                "properties": {
                    "noteId": { "type": "string", "minLength": 1, "maxLength": 300 },
                    "baseVersion": { "type": "string", "minLength": 1, "maxLength": 300 }
                },
                "required": ["noteId", "baseVersion"],
                "additionalProperties": false
            }
        ]
    })
}

fn knowledge_blueprint_output_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "outputId": { "type": "string", "minLength": 1, "maxLength": 300 },
            "operation": { "type": "string", "enum": ["create", "revise"] },
            "kind": { "type": "string", "enum": ["note", "wikiArticle"] },
            "title": { "type": "string", "minLength": 1, "maxLength": 300 },
            "editorialBrief": { "type": "string", "minLength": 1, "maxLength": 4_000 },
            "sourceIds": {
                "type": "array",
                "minItems": 1,
                "maxItems": 24,
                "items": { "type": "string", "minLength": 1, "maxLength": 300 }
            },
            "claimSelections": {
                "type": "array",
                "minItems": 1,
                "maxItems": 100,
                "items": knowledge_evidence_selection_schema("claimIds")
            },
            "lensSelections": {
                "type": "array",
                "maxItems": 100,
                "items": knowledge_evidence_selection_schema("interpretationIds")
            },
            "mustPreserve": knowledge_string_array_schema(100),
            "estimatedTokens": { "type": "integer", "minimum": 128, "maximum": 12_000 },
            "writerSlotId": { "type": "string", "minLength": 1, "maxLength": 300 },
            "existingDestination": knowledge_existing_destination_schema()
        },
        "required": [
            "outputId", "operation", "kind", "title", "editorialBrief",
            "sourceIds", "claimSelections", "lensSelections", "mustPreserve",
            "estimatedTokens", "writerSlotId", "existingDestination"
        ],
        "additionalProperties": false
    })
}

fn knowledge_writing_blueprint_schema() -> Value {
    let organizer = organizer_schema();
    let concepts = organizer
        .pointer("/properties/concepts")
        .cloned()
        .expect("organizer concepts schema exists");
    let suggested_connections = organizer
        .pointer("/properties/suggestedConnections")
        .cloned()
        .expect("organizer connection schema exists");
    json!({
        "type": "object",
        "properties": {
            "spaceThesis": { "type": "string", "minLength": 1, "maxLength": 8_000 },
            "outputs": {
                "type": "array",
                "minItems": 1,
                "maxItems": MAX_ORGANIZED_ITEMS,
                "items": knowledge_blueprint_output_schema()
            },
            "seedDispositions": {
                "type": "array",
                "maxItems": 200,
                "items": {
                    "type": "object",
                    "properties": {
                        "artifactId": { "type": "string", "minLength": 1, "maxLength": 300 },
                        "seedId": { "type": "string", "minLength": 1, "maxLength": 300 },
                        "disposition": { "type": "string", "enum": ["output", "merged", "omitted"] },
                        "outputId": {
                            "anyOf": [
                                { "type": "null" },
                                { "type": "string", "minLength": 1, "maxLength": 300 }
                            ]
                        },
                        "rationale": { "type": "string", "minLength": 1, "maxLength": 4_000 }
                    },
                    "required": ["artifactId", "seedId", "disposition", "outputId", "rationale"],
                    "additionalProperties": false
                }
            },
            "writerSlots": {
                "type": "array",
                "minItems": 1,
                "maxItems": 6,
                "items": {
                    "type": "object",
                    "properties": {
                        "writerSlotId": { "type": "string", "minLength": 1, "maxLength": 300 },
                        "objective": { "type": "string", "minLength": 1, "maxLength": 2_000 },
                        "outputIds": {
                            "type": "array",
                            "minItems": 1,
                            "maxItems": MAX_ORGANIZED_ITEMS,
                            "items": { "type": "string", "minLength": 1, "maxLength": 300 }
                        }
                    },
                    "required": ["writerSlotId", "objective", "outputIds"],
                    "additionalProperties": false
                }
            },
            "concepts": concepts,
            "suggestedConnections": suggested_connections,
            "warnings": knowledge_string_array_schema(80)
        },
        "required": [
            "spaceThesis", "outputs", "seedDispositions", "writerSlots", "concepts",
            "suggestedConnections", "warnings"
        ],
        "additionalProperties": false
    })
}

fn knowledge_writer_draft_schema() -> Value {
    let organizer = organizer_schema();
    let links = organizer
        .pointer("/properties/notes/items/properties/links")
        .cloned()
        .expect("organizer links schema exists");
    json!({
        "type": "object",
        "properties": {
            "outputId": { "type": "string", "minLength": 1, "maxLength": 300 },
            "operation": { "type": "string", "enum": ["create", "revise"] },
            "kind": { "type": "string", "enum": ["note", "wikiArticle"] },
            "title": { "type": "string", "minLength": 1, "maxLength": 300 },
            "summary": { "type": "string", "maxLength": 2_000 },
            "body": { "type": "string", "maxLength": 100_000 },
            "tags": knowledge_string_array_schema(24),
            "aliases": knowledge_string_array_schema(24),
            "links": links,
            "overview": { "type": "string", "maxLength": 4_000 },
            "spaceRelevance": { "type": "string", "maxLength": 8_000 },
            "sourceGroundedDetails": knowledge_string_array_schema(100),
            "uncertainties": knowledge_string_array_schema(100),
            "sourceIds": {
                "type": "array",
                "minItems": 1,
                "maxItems": 24,
                "items": { "type": "string", "minLength": 1, "maxLength": 300 }
            },
            "claimSelections": {
                "type": "array",
                "minItems": 1,
                "maxItems": 100,
                "items": knowledge_evidence_selection_schema("claimIds")
            },
            "lensSelections": {
                "type": "array",
                "maxItems": 100,
                "items": knowledge_evidence_selection_schema("interpretationIds")
            },
            "mustPreserve": knowledge_string_array_schema(100),
            "existingDestination": knowledge_existing_destination_schema()
        },
        "required": [
            "outputId", "operation", "kind", "title", "summary", "body",
            "tags", "aliases", "links", "overview", "spaceRelevance",
            "sourceGroundedDetails", "uncertainties", "sourceIds",
            "claimSelections", "lensSelections", "mustPreserve", "existingDestination"
        ],
        "additionalProperties": false
    })
}

fn knowledge_writer_result_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "writerSlotId": { "type": "string", "minLength": 1, "maxLength": 300 },
            "drafts": {
                "type": "array",
                "minItems": 1,
                "maxItems": MAX_ORGANIZED_ITEMS,
                "items": knowledge_writer_draft_schema()
            },
            "warnings": knowledge_string_array_schema(80)
        },
        "required": ["writerSlotId", "drafts", "warnings"],
        "additionalProperties": false
    })
}

fn knowledge_note_routing_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "rangeId": { "type": "string", "minLength": 1, "maxLength": 300 },
            "routes": {
                "type": "array",
                "minItems": 1,
                "maxItems": 100,
                "items": {
                    "type": "object",
                    "properties": {
                        "noteId": { "type": "string", "minLength": 1, "maxLength": 300 },
                        "noteVersion": { "type": "string", "minLength": 1, "maxLength": 300 },
                        "relation": {
                            "type": "string",
                            "enum": [
                                "unrelated",
                                "duplicate",
                                "extends",
                                "contradicts",
                                "uncertain"
                            ]
                        },
                        "rationale": { "type": "string", "minLength": 1, "maxLength": 2_000 },
                        "candidateNoteIds": {
                            "type": "array",
                            "maxItems": 100,
                            "items": { "type": "string", "minLength": 1, "maxLength": 300 }
                        }
                    },
                    "required": [
                        "noteId", "noteVersion", "relation", "rationale", "candidateNoteIds"
                    ],
                    "additionalProperties": false
                }
            },
            "warnings": knowledge_string_array_schema(80)
        },
        "required": ["rangeId", "routes", "warnings"],
        "additionalProperties": false
    })
}

fn knowledge_validation_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "valid": { "type": "boolean" },
            "issues": knowledge_string_array_schema(80),
            "checkedArtifactIds": {
                "type": "array",
                "minItems": 1,
                "maxItems": 100,
                "items": { "type": "string", "minLength": 1, "maxLength": 300 }
            }
        },
        "required": ["valid", "issues", "checkedArtifactIds"],
        "additionalProperties": false
    })
}

fn knowledge_artifact_payload_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "summary": { "type": "string", "minLength": 1, "maxLength": 4_000 },
            "body": { "type": "string", "maxLength": 64_000 },
            "assessment": {
                "type": "object",
                "properties": {
                    "spaceRelevance": { "type": "string", "enum": ["low", "medium", "high"] },
                    "sourceImportance": { "type": "string", "enum": ["low", "medium", "high"] },
                    "novelty": { "type": "string", "enum": ["low", "medium", "high"] },
                    "focusConcepts": knowledge_string_array_schema(40),
                    "deprioritizedConcepts": knowledge_string_array_schema(40),
                    "reviewedNoteIds": {
                        "type": "array",
                        "maxItems": 100,
                        "items": { "type": "string", "minLength": 1, "maxLength": 300 }
                    },
                    "rationale": { "type": "string", "minLength": 1, "maxLength": 4_000 }
                },
                "required": [
                    "spaceRelevance", "sourceImportance", "novelty",
                    "focusConcepts", "deprioritizedConcepts", "reviewedNoteIds",
                    "rationale"
                ],
                "additionalProperties": false
            },
            "claims": {
                "type": "array",
                "maxItems": 100,
                "items": {
                    "type": "object",
                    "properties": {
                        "text": { "type": "string", "minLength": 1, "maxLength": 4_000 },
                        "references": {
                            "type": "array",
                            "maxItems": 40,
                            "items": knowledge_reference_schema()
                        }
                    },
                    "required": ["text", "references"],
                    "additionalProperties": false
                }
            },
            "references": {
                "type": "array",
                "maxItems": 100,
                "items": knowledge_reference_schema()
            },
            "mustPreserve": knowledge_string_array_schema(100),
            "ownerProposals": {
                "type": "array",
                "maxItems": 30,
                "items": knowledge_owner_proposal_schema()
            },
            "validation": {
                "anyOf": [
                    { "type": "null" },
                    knowledge_validation_schema()
                ]
            }
        },
        "required": [
            "summary", "body", "assessment", "claims", "references", "mustPreserve",
            "ownerProposals", "validation"
        ],
        "additionalProperties": false
    })
}

fn knowledge_root_result_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "result": organizer_schema(),
            "provenance": {
                "type": "array",
                "maxItems": MAX_ORGANIZED_ITEMS,
                "items": {
                    "type": "object",
                    "properties": {
                        "kind": { "type": "string", "enum": ["note", "wikiArticle"] },
                        "title": { "type": "string", "minLength": 1, "maxLength": 300 },
                        "sourceIds": {
                            "type": "array",
                            "maxItems": 12,
                            "items": { "type": "string", "minLength": 1, "maxLength": 300 }
                        },
                        "evidenceReferences": {
                            "type": "array",
                            "maxItems": 100,
                            "items": knowledge_reference_schema()
                        }
                    },
                    "required": ["kind", "title", "sourceIds", "evidenceReferences"],
                    "additionalProperties": false
                }
            },
            "ownerProposals": {
                "type": "array",
                "maxItems": 30,
                "items": knowledge_owner_proposal_schema()
            },
            "warnings": knowledge_string_array_schema(80)
        },
        "required": ["result", "provenance", "ownerProposals", "warnings"],
        "additionalProperties": false
    })
}

fn knowledge_assignment_schema() -> Value {
    let identifier_array = json!({
        "type": "array",
        "minItems": 1,
        "maxItems": 100,
        "items": { "type": "string", "minLength": 1, "maxLength": 300 }
    });
    json!({
        "type": "object",
        "properties": {
            "assignmentId": { "type": "string", "minLength": 1, "maxLength": 300 },
            "parent": {
                "anyOf": [
                    {
                        "type": "object",
                        "properties": {
                            "kind": { "type": "string", "const": "run" },
                            "runId": { "type": "string", "minLength": 1, "maxLength": 300 }
                        },
                        "required": ["kind", "runId"],
                        "additionalProperties": false
                    },
                    {
                        "type": "object",
                        "properties": {
                            "kind": { "type": "string", "const": "assignment" },
                            "assignmentId": { "type": "string", "minLength": 1, "maxLength": 300 }
                        },
                        "required": ["kind", "assignmentId"],
                        "additionalProperties": false
                    }
                ]
            },
            "purpose": {
                "type": "string",
                "enum": ["root", "evidence", "reconciler", "compressor", "owner", "validator"]
            },
            "objective": { "type": "string", "minLength": 1, "maxLength": 2_000 },
            "references": {
                "type": "array",
                "maxItems": 100,
                "items": knowledge_reference_schema()
            },
            "constraints": {
                "type": "object",
                "properties": {
                    "rules": knowledge_string_array_schema(100),
                    "mustPreserve": knowledge_string_array_schema(100)
                },
                "required": ["rules", "mustPreserve"],
                "additionalProperties": false
            },
            "authority": {
                "anyOf": [
                    {
                        "type": "object",
                        "properties": {
                            "kind": { "type": "string", "const": "read-only" }
                        },
                        "required": ["kind"],
                        "additionalProperties": false
                    },
                    {
                        "type": "object",
                        "properties": {
                            "kind": { "type": "string", "const": "destination-owner" },
                            "destinationNoteIds": identifier_array,
                            "baseVersions": {
                                "type": "array",
                                "minItems": 1,
                                "maxItems": 100,
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "noteId": { "type": "string", "minLength": 1, "maxLength": 300 },
                                        "version": { "type": "string", "minLength": 1, "maxLength": 300 }
                                    },
                                    "required": ["noteId", "version"],
                                    "additionalProperties": false
                                }
                            }
                        },
                        "required": ["kind", "destinationNoteIds", "baseVersions"],
                        "additionalProperties": false
                    }
                ]
            },
            "output": {
                "anyOf": [
                    {
                        "type": "object",
                        "properties": { "kind": { "type": "string", "const": "root-result" } },
                        "required": ["kind"],
                        "additionalProperties": false
                    },
                    {
                        "type": "object",
                        "properties": { "kind": { "type": "string", "const": "evidence" } },
                        "required": ["kind"],
                        "additionalProperties": false
                    },
                    {
                        "type": "object",
                        "properties": { "kind": { "type": "string", "const": "reconciliation" } },
                        "required": ["kind"],
                        "additionalProperties": false
                    },
                    {
                        "type": "object",
                        "properties": { "kind": { "type": "string", "const": "compression" } },
                        "required": ["kind"],
                        "additionalProperties": false
                    },
                    {
                        "type": "object",
                        "properties": {
                            "kind": { "type": "string", "const": "owner-proposal" },
                            "destinationNoteIds": identifier_array
                        },
                        "required": ["kind", "destinationNoteIds"],
                        "additionalProperties": false
                    },
                    {
                        "type": "object",
                        "properties": {
                            "kind": { "type": "string", "const": "validation" },
                            "proposalArtifactIds": identifier_array
                        },
                        "required": ["kind", "proposalArtifactIds"],
                        "additionalProperties": false
                    }
                ]
            },
            "termination": {
                "type": "object",
                "properties": {
                    "condition": { "type": "string", "minLength": 1, "maxLength": 1_000 }
                },
                "required": ["condition"],
                "additionalProperties": false
            }
        },
        "required": [
            "assignmentId", "parent", "purpose", "objective", "references",
            "constraints", "authority", "output", "termination"
        ],
        "additionalProperties": false
    })
}

fn knowledge_coordination_call_schema() -> Value {
    let artifact_ids = json!({
        "type": "array",
        "minItems": 1,
        "maxItems": 100,
        "items": { "type": "string", "minLength": 1, "maxLength": 300 }
    });
    let assignments = json!({
        "type": "array",
        "minItems": 1,
        "maxItems": 100,
        "items": knowledge_assignment_schema()
    });
    let base = |primitive: &str, properties: Value, required: Vec<&str>| {
        let mut all_properties = json!({
            "primitive": { "type": "string", "const": primitive },
            "callId": { "type": "string", "minLength": 1, "maxLength": 300 }
        });
        if let (Some(target), Some(extra)) =
            (all_properties.as_object_mut(), properties.as_object())
        {
            target.extend(extra.clone());
        }
        let mut all_required = vec!["primitive", "callId"];
        all_required.extend(required);
        json!({
            "type": "object",
            "properties": all_properties,
            "required": all_required,
            "additionalProperties": false
        })
    };
    json!({
        "anyOf": [
            base("fan_out", json!({ "assignments": assignments }), vec!["assignments"]),
            base(
                "reconcile",
                json!({
                    "assignment": knowledge_assignment_schema(),
                    "inputArtifactIds": artifact_ids
                }),
                vec!["assignment", "inputArtifactIds"]
            ),
            base(
                "compress",
                json!({
                    "assignment": knowledge_assignment_schema(),
                    "inputArtifactIds": artifact_ids,
                    "mustPreserve": knowledge_string_array_schema(100)
                }),
                vec!["assignment", "inputArtifactIds", "mustPreserve"]
            ),
            base(
                "assign_owner",
                json!({ "assignment": knowledge_assignment_schema() }),
                vec!["assignment"]
            ),
            base(
                "re_expand",
                json!({
                    "assignments": assignments,
                    "fromArtifactIds": artifact_ids
                }),
                vec!["assignments", "fromArtifactIds"]
            ),
            base(
                "validate",
                json!({
                    "assignment": knowledge_assignment_schema(),
                    "proposalArtifactIds": artifact_ids
                }),
                vec!["assignment", "proposalArtifactIds"]
            ),
            base(
                "re_evaluate",
                json!({
                    "assignment": knowledge_assignment_schema(),
                    "priorArtifactIds": artifact_ids,
                    "observationIds": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 100,
                        "items": { "type": "string", "minLength": 1, "maxLength": 300 }
                    }
                }),
                vec!["assignment", "priorArtifactIds", "observationIds"]
            )
        ]
    })
}

const KNOWLEDGE_ENUM_MAX_VALUES: usize = 500;
const KNOWLEDGE_ENUM_MAX_BYTES: usize = 60_000;

// Contract identifiers may only tighten a schema when every candidate is a
// well-formed string: a partially extracted enum would reject responses the
// contract actually allows, so any malformed candidate disables injection.
fn contracted_identifier_values<'a, I>(candidates: Option<I>) -> Option<Vec<String>>
where
    I: IntoIterator<Item = Option<&'a str>>,
{
    let mut values: Vec<String> = Vec::new();
    for candidate in candidates? {
        let value = candidate?;
        if value.is_empty() || value.len() > 300 {
            return None;
        }
        if !values.iter().any(|existing| existing == value) {
            values.push(value.to_string());
        }
    }
    if values.is_empty() {
        None
    } else {
        Some(values)
    }
}

fn knowledge_pipeline_material_payloads<'a>(
    context: &'a Value,
    kind: &str,
) -> Option<Vec<&'a Value>> {
    let materials = context.get("pipelineMaterials")?.as_array()?;
    let mut payloads = Vec::new();
    for material in materials {
        if material.get("kind").and_then(Value::as_str) != Some(kind) {
            continue;
        }
        let payload = material.get("payload")?;
        if !payload.is_object() {
            return None;
        }
        payloads.push(payload);
    }
    if payloads.is_empty() {
        None
    } else {
        Some(payloads)
    }
}

fn contracted_nested_identifier_values(
    payloads: Option<&Vec<&Value>>,
    entries_pointer: &str,
    id_field: &str,
) -> Option<Vec<String>> {
    let mut candidates = Vec::new();
    for payload in payloads? {
        for entry in payload.pointer(entries_pointer)?.as_array()? {
            candidates.push(entry.get(id_field).and_then(Value::as_str));
        }
    }
    contracted_identifier_values(Some(candidates))
}

// Enum injection is best-effort hardening: over-cap or over-budget contracts
// silently keep the plain string schema so building the schema can never fail
// or bloat a provider request.
fn inject_contracted_enum(
    payload: &mut Value,
    pointer: &str,
    values: Option<&Vec<String>>,
    remaining_bytes: &mut usize,
) {
    let Some(values) = values else { return };
    if values.is_empty() || values.len() > KNOWLEDGE_ENUM_MAX_VALUES {
        return;
    }
    let added_bytes = serde_json::to_string(values).map_or(usize::MAX, |encoded| encoded.len());
    if added_bytes > *remaining_bytes {
        return;
    }
    let Some(target) = payload.pointer_mut(pointer) else {
        return;
    };
    *remaining_bytes -= added_bytes;
    *target = json!({ "type": "string", "enum": values });
}

// The valid identifiers for a fixed-pipeline response are already contracted
// inside the request, so the response schema can make hallucinated
// identifiers impossible at decode time. Cross-field pairing (which claim
// belongs to which artifact) stays with the downstream validators.
fn apply_knowledge_contract_enums(
    expected_output: &str,
    assignment: &Value,
    context: &Value,
    payload: &mut Value,
) {
    let mut remaining_bytes = KNOWLEDGE_ENUM_MAX_BYTES;
    match expected_output {
        "note-routing" => {
            let expected_notes = assignment
                .pointer("/output/expectedNotes")
                .and_then(Value::as_array);
            let range_id = contracted_identifier_values(
                assignment
                    .pointer("/output/rangeId")
                    .map(|value| std::iter::once(value.as_str())),
            );
            let note_ids = contracted_identifier_values(expected_notes.map(|notes| {
                notes
                    .iter()
                    .map(|note| note.get("noteId").and_then(Value::as_str))
            }));
            let note_versions = contracted_identifier_values(expected_notes.map(|notes| {
                notes
                    .iter()
                    .map(|note| note.get("noteVersion").and_then(Value::as_str))
            }));
            inject_contracted_enum(
                payload,
                "/properties/rangeId",
                range_id.as_ref(),
                &mut remaining_bytes,
            );
            inject_contracted_enum(
                payload,
                "/properties/routes/items/properties/noteId",
                note_ids.as_ref(),
                &mut remaining_bytes,
            );
            inject_contracted_enum(
                payload,
                "/properties/routes/items/properties/noteVersion",
                note_versions.as_ref(),
                &mut remaining_bytes,
            );
        }
        "writing-blueprint" => {
            let readings = knowledge_pipeline_material_payloads(context, "source-reading");
            let artifact_ids = contracted_identifier_values(readings.as_ref().map(|payloads| {
                payloads
                    .iter()
                    .map(|payload| payload.get("artifactId").and_then(Value::as_str))
            }));
            let claim_ids = contracted_nested_identifier_values(
                readings.as_ref(),
                "/reading/sourceClaims",
                "claimId",
            );
            let interpretation_ids = contracted_nested_identifier_values(
                readings.as_ref(),
                "/reading/spaceInterpretations",
                "interpretationId",
            );
            let seed_ids = contracted_nested_identifier_values(
                readings.as_ref(),
                "/reading/synthesisSeeds",
                "seedId",
            );
            let outputs = "/properties/outputs/items/properties";
            inject_contracted_enum(
                payload,
                &format!("{outputs}/claimSelections/items/properties/artifactId"),
                artifact_ids.as_ref(),
                &mut remaining_bytes,
            );
            inject_contracted_enum(
                payload,
                &format!("{outputs}/claimSelections/items/properties/claimIds/items"),
                claim_ids.as_ref(),
                &mut remaining_bytes,
            );
            inject_contracted_enum(
                payload,
                &format!("{outputs}/lensSelections/items/properties/artifactId"),
                artifact_ids.as_ref(),
                &mut remaining_bytes,
            );
            inject_contracted_enum(
                payload,
                &format!("{outputs}/lensSelections/items/properties/interpretationIds/items"),
                interpretation_ids.as_ref(),
                &mut remaining_bytes,
            );
            let dispositions = "/properties/seedDispositions/items/properties";
            inject_contracted_enum(
                payload,
                &format!("{dispositions}/artifactId"),
                artifact_ids.as_ref(),
                &mut remaining_bytes,
            );
            inject_contracted_enum(
                payload,
                &format!("{dispositions}/seedId"),
                seed_ids.as_ref(),
                &mut remaining_bytes,
            );
        }
        "writer-result" => {
            let blueprints = knowledge_pipeline_material_payloads(context, "writing-blueprint");
            let output_ids = contracted_nested_identifier_values(
                blueprints.as_ref(),
                "/assignedOutputs",
                "outputId",
            );
            inject_contracted_enum(
                payload,
                "/properties/drafts/items/properties/outputId",
                output_ids.as_ref(),
                &mut remaining_bytes,
            );
        }
        _ => {}
    }
}

pub(super) fn knowledge_response_schema(
    expected_output: &str,
    assignment: &Value,
    context: &Value,
) -> Result<Value, String> {
    let mut payload = match expected_output {
        "root-result" => knowledge_root_result_schema(),
        "note-routing" => knowledge_note_routing_schema(),
        "reading-blueprint" => knowledge_reading_blueprint_schema(),
        "source-reading" => knowledge_source_reading_schema(),
        "writing-blueprint" => knowledge_writing_blueprint_schema(),
        "writer-result" => knowledge_writer_result_schema(),
        "evidence" | "reconciliation" | "compression" | "owner-proposal" | "validation" => {
            knowledge_artifact_payload_schema()
        }
        _ => {
            return Err("The knowledge assignment has an unsupported output contract.".to_string())
        }
    };
    apply_knowledge_contract_enums(expected_output, assignment, context, &mut payload);
    let fixed_pipeline_output = matches!(
        expected_output,
        "note-routing"
            | "reading-blueprint"
            | "source-reading"
            | "writing-blueprint"
            | "writer-result"
    );
    if fixed_pipeline_output {
        return Ok(json!({
            "type": "object",
            "properties": {
                "kind": { "type": "string", "const": "complete" },
                "payload": payload,
                "calls": { "type": "null" }
            },
            "required": ["kind", "payload", "calls"],
            "additionalProperties": false
        }));
    }
    Ok(json!({
        "type": "object",
        "properties": {
            "kind": {
                "type": "string",
                "enum": ["complete", "coordinate"]
            },
            "payload": {
                "anyOf": [
                    { "type": "null" },
                    payload
                ]
            },
            "calls": {
                "anyOf": [
                    { "type": "null" },
                    {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 100,
                        "items": knowledge_coordination_call_schema()
                    }
                ]
            }
        },
        "required": ["kind", "payload", "calls"],
        "additionalProperties": false
    }))
}

pub(super) fn anthropic_knowledge_response_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "kind": {
                "type": "string",
                "enum": ["complete", "coordinate"]
            },
            "dataJson": {
                "type": "string",
                "description": "JSON-encoded completion payload or coordination-call array for the active kind."
            }
        },
        "required": ["kind", "dataJson"],
        "additionalProperties": false
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_openai_strict_objects(schema: &Value, path: &str) {
        match schema {
            Value::Object(object) => {
                if object.get("type") == Some(&json!("object")) {
                    let properties = object
                        .get("properties")
                        .and_then(Value::as_object)
                        .unwrap_or_else(|| panic!("missing properties at {path}"));
                    let required = object
                        .get("required")
                        .and_then(Value::as_array)
                        .unwrap_or_else(|| panic!("missing required at {path}"));
                    let mut property_names = properties.keys().cloned().collect::<Vec<_>>();
                    let mut required_names = required
                        .iter()
                        .map(|value| {
                            value
                                .as_str()
                                .unwrap_or_else(|| panic!("non-string required field at {path}"))
                                .to_string()
                        })
                        .collect::<Vec<_>>();
                    property_names.sort();
                    required_names.sort();
                    assert_eq!(required_names, property_names, "optional field at {path}");
                    assert_eq!(
                        object.get("additionalProperties"),
                        Some(&json!(false)),
                        "additional properties allowed at {path}"
                    );
                }
                for (key, value) in object {
                    assert_openai_strict_objects(value, &format!("{path}/{key}"));
                }
            }
            Value::Array(values) => {
                for (index, value) in values.iter().enumerate() {
                    assert_openai_strict_objects(value, &format!("{path}/{index}"));
                }
            }
            _ => {}
        }
    }

    #[test]
    fn knowledge_schemas_keep_openai_strict_and_anthropic_compact() {
        let no_contract = json!({});
        let root = knowledge_response_schema("root-result", &no_contract, &no_contract).unwrap();
        let evidence = knowledge_response_schema("evidence", &no_contract, &no_contract).unwrap();
        let note_routing =
            knowledge_response_schema("note-routing", &no_contract, &no_contract).unwrap();
        let reading_blueprint =
            knowledge_response_schema("reading-blueprint", &no_contract, &no_contract).unwrap();
        let source_reading =
            knowledge_response_schema("source-reading", &no_contract, &no_contract).unwrap();
        let writing_blueprint =
            knowledge_response_schema("writing-blueprint", &no_contract, &no_contract).unwrap();
        let writer_result =
            knowledge_response_schema("writer-result", &no_contract, &no_contract).unwrap();
        let root_text = root.to_string();
        let evidence_text = evidence.to_string();

        for primitive in [
            "fan_out",
            "reconcile",
            "compress",
            "assign_owner",
            "re_expand",
            "validate",
            "re_evaluate",
        ] {
            assert!(root_text.contains(primitive));
            assert!(evidence_text.contains(primitive));
        }
        assert_eq!(root.pointer("/type"), Some(&json!("object")));
        assert!(root.get("anyOf").is_none());
        assert_eq!(
            root.pointer("/required"),
            Some(&json!(["kind", "payload", "calls"]))
        );
        assert!(root
            .pointer("/properties/payload/anyOf/1/properties/result")
            .is_some());
        assert!(evidence
            .pointer("/properties/payload/anyOf/1/properties/claims")
            .is_some());
        assert_openai_strict_objects(&root, "root");
        assert_openai_strict_objects(&evidence, "evidence");
        assert_openai_strict_objects(&note_routing, "note routing");
        assert_openai_strict_objects(&reading_blueprint, "reading blueprint");
        assert_openai_strict_objects(&source_reading, "source reading");
        assert_openai_strict_objects(&writing_blueprint, "writing blueprint");
        assert_openai_strict_objects(&writer_result, "writer result");
        for fixed in [
            &note_routing,
            &reading_blueprint,
            &source_reading,
            &writing_blueprint,
            &writer_result,
        ] {
            assert_eq!(
                fixed.pointer("/properties/kind/const"),
                Some(&json!("complete"))
            );
            assert_eq!(
                fixed.pointer("/properties/calls/type"),
                Some(&json!("null"))
            );
            assert!(fixed.pointer("/properties/calls/anyOf").is_none());
        }
        assert!(note_routing
            .pointer("/properties/payload/properties/routes/items/properties/noteVersion")
            .is_some());
        assert_eq!(
            note_routing
                .pointer("/properties/payload/properties/routes/items/properties/relation/enum"),
            Some(&json!([
                "unrelated",
                "duplicate",
                "extends",
                "contradicts",
                "uncertain"
            ]))
        );
        assert!(reading_blueprint
            .pointer("/properties/payload/properties/readers/items/properties/rangeId")
            .is_some());
        assert!(source_reading
            .pointer("/properties/payload/properties/sourceClaims/items/properties/support")
            .is_some());
        assert!(source_reading
            .pointer("/properties/payload/properties/spaceInterpretations")
            .is_some());
        assert_eq!(
            source_reading.pointer(
                "/properties/payload/properties/synthesisSeeds/items/properties/contribution/enum"
            ),
            Some(&json!([
                "new",
                "extends",
                "contradicts",
                "connects",
                "qualifies"
            ]))
        );
        assert_eq!(
            source_reading.pointer(
                "/properties/payload/properties/synthesisSeeds/items/properties/importance/enum"
            ),
            Some(&json!(["high", "medium", "low"]))
        );
        assert_eq!(
            source_reading.pointer(
                "/properties/payload/properties/synthesisSeeds/items/properties/claimIds/maxItems"
            ),
            Some(&json!(4))
        );
        assert_eq!(
            writing_blueprint.pointer("/properties/payload/properties/writerSlots/maxItems"),
            Some(&json!(6))
        );
        assert_eq!(
            writing_blueprint.pointer(
                "/properties/payload/properties/seedDispositions/items/properties/disposition/enum"
            ),
            Some(&json!(["output", "merged", "omitted"]))
        );
        assert!(writer_result
            .pointer("/properties/payload/properties/drafts/items/properties/claimSelections")
            .is_some());
        assert!(writer_result
            .pointer("/properties/payload/properties/drafts/items/properties/mustPreserve")
            .is_some());
        let coordination_assignment = knowledge_assignment_schema().to_string();
        assert!(!coordination_assignment.contains("reading-blueprint"));
        assert!(!coordination_assignment.contains("note-routing"));
        assert!(!coordination_assignment.contains("router"));
        assert!(!coordination_assignment.contains("source-reader"));
        assert!(!coordination_assignment.contains("writing-blueprint"));
        assert!(!coordination_assignment.contains("writer-result"));
        assert!(!root_text.contains("desiredWidth"));
        assert!(!root_text.contains("maxNodes"));
        assert!(!root_text.contains("researcher"));
        assert_eq!(
            root.pointer("/properties/payload/anyOf/1/properties/result/properties/notes/maxItems"),
            Some(&json!(MAX_ORGANIZED_ITEMS))
        );
        assert_eq!(
            root.pointer(
                "/properties/payload/anyOf/1/properties/result/properties/wikiArticles/maxItems"
            ),
            Some(&json!(MAX_ORGANIZED_ITEMS))
        );
        assert_eq!(
            root.pointer("/properties/payload/anyOf/1/properties/provenance/maxItems"),
            Some(&json!(MAX_ORGANIZED_ITEMS))
        );

        let anthropic = anthropic_knowledge_response_schema();
        let anthropic_text = anthropic.to_string();
        for unsupported in [
            "anyOf",
            "minLength",
            "maxLength",
            "minItems",
            "maxItems",
            "minimum",
            "maximum",
        ] {
            assert!(!anthropic_text.contains(unsupported));
        }
        let anthropic_organizer = anthropic_organizer_schema().to_string();
        assert!(!anthropic_organizer.contains("maxItems"));
        assert!(!anthropic_organizer.contains("minItems"));
    }

    #[test]
    fn routing_schema_constrains_identifiers_to_the_contract() {
        let assignment = json!({
            "output": {
                "kind": "note-routing",
                "rangeId": "notes-1",
                "expectedNotes": [
                    { "noteId": "note-a", "noteVersion": "v-a" },
                    { "noteId": "note-b", "noteVersion": "v-b" },
                    { "noteId": "note-c", "noteVersion": "v-b" }
                ]
            }
        });
        let schema = knowledge_response_schema("note-routing", &assignment, &json!({})).unwrap();
        let routes = "/properties/payload/properties/routes/items/properties";
        assert_eq!(
            schema.pointer("/properties/payload/properties/rangeId/enum"),
            Some(&json!(["notes-1"]))
        );
        assert_eq!(
            schema.pointer(&format!("{routes}/noteId/enum")),
            Some(&json!(["note-a", "note-b", "note-c"]))
        );
        assert_eq!(
            schema.pointer(&format!("{routes}/noteVersion/enum")),
            Some(&json!(["v-a", "v-b"]))
        );
        assert_eq!(
            schema.pointer(&format!("{routes}/relation/enum")),
            Some(&json!([
                "unrelated",
                "duplicate",
                "extends",
                "contradicts",
                "uncertain"
            ]))
        );
        assert_openai_strict_objects(&schema, "routing with contract enums");
    }

    #[test]
    fn writing_blueprint_schema_constrains_selections_to_the_readings() {
        let context = json!({
            "pipelineMaterials": [
                {
                    "kind": "source-reading",
                    "trust": "source-evidence",
                    "payload": {
                        "artifactId": "artifact-1",
                        "reading": {
                            "sourceClaims": [
                                { "claimId": "range1-claim-01" },
                                { "claimId": "range1-claim-02" }
                            ],
                            "synthesisSeeds": [
                                { "seedId": "range1-seed-01" },
                                { "seedId": "range1-seed-02" }
                            ],
                            "spaceInterpretations": [
                                { "interpretationId": "range1-lens-01" }
                            ]
                        }
                    }
                },
                {
                    "kind": "source-reading",
                    "trust": "source-evidence",
                    "payload": {
                        "artifactId": "artifact-2",
                        "reading": {
                            "sourceClaims": [{ "claimId": "range2-claim-01" }],
                            "synthesisSeeds": [{ "seedId": "range2-seed-01" }],
                            "spaceInterpretations": [
                                { "interpretationId": "range2-lens-01" }
                            ]
                        }
                    }
                },
                { "kind": "space-orientation", "trust": "untrusted-context", "payload": {} }
            ]
        });
        let schema = knowledge_response_schema("writing-blueprint", &json!({}), &context).unwrap();
        let outputs = "/properties/payload/properties/outputs/items/properties";
        assert_eq!(
            schema.pointer(&format!(
                "{outputs}/claimSelections/items/properties/artifactId/enum"
            )),
            Some(&json!(["artifact-1", "artifact-2"]))
        );
        assert_eq!(
            schema.pointer(&format!(
                "{outputs}/claimSelections/items/properties/claimIds/items/enum"
            )),
            Some(&json!([
                "range1-claim-01",
                "range1-claim-02",
                "range2-claim-01"
            ]))
        );
        assert_eq!(
            schema.pointer(&format!(
                "{outputs}/lensSelections/items/properties/artifactId/enum"
            )),
            Some(&json!(["artifact-1", "artifact-2"]))
        );
        assert_eq!(
            schema.pointer(&format!(
                "{outputs}/lensSelections/items/properties/interpretationIds/items/enum"
            )),
            Some(&json!(["range1-lens-01", "range2-lens-01"]))
        );
        let dispositions = "/properties/payload/properties/seedDispositions/items/properties";
        assert_eq!(
            schema.pointer(&format!("{dispositions}/artifactId/enum")),
            Some(&json!(["artifact-1", "artifact-2"]))
        );
        assert_eq!(
            schema.pointer(&format!("{dispositions}/seedId/enum")),
            Some(&json!([
                "range1-seed-01",
                "range1-seed-02",
                "range2-seed-01"
            ]))
        );
        assert_openai_strict_objects(&schema, "writing blueprint with contract enums");
    }

    #[test]
    fn writer_result_schema_constrains_draft_output_ids_when_contracted() {
        let context = json!({
            "pipelineMaterials": [{
                "kind": "writing-blueprint",
                "trust": "untrusted-context",
                "payload": {
                    "spaceThesis": "The Space centers on grounded evidence.",
                    "assignedOutputs": [
                        { "outputId": "output-1" },
                        { "outputId": "output-2" }
                    ]
                }
            }]
        });
        let schema = knowledge_response_schema("writer-result", &json!({}), &context).unwrap();
        let output_id = "/properties/payload/properties/drafts/items/properties/outputId";
        assert_eq!(
            schema.pointer(&format!("{output_id}/enum")),
            Some(&json!(["output-1", "output-2"]))
        );
        assert_openai_strict_objects(&schema, "writer result with contract enums");

        let uncontracted =
            knowledge_response_schema("writer-result", &json!({}), &json!({})).unwrap();
        assert!(uncontracted.pointer(&format!("{output_id}/enum")).is_none());
        assert_eq!(
            uncontracted.pointer(&format!("{output_id}/maxLength")),
            Some(&json!(300))
        );
    }

    #[test]
    fn oversized_or_malformed_contracts_keep_plain_string_schemas() {
        let routes = "/properties/payload/properties/routes/items/properties";
        let contract = |notes: Vec<Value>| {
            json!({
                "output": {
                    "kind": "note-routing",
                    "rangeId": "notes-1",
                    "expectedNotes": notes
                }
            })
        };

        let too_many = contract(
            (0..501)
                .map(|index| {
                    json!({
                        "noteId": format!("note-{index}"),
                        "noteVersion": format!("v-{index}")
                    })
                })
                .collect(),
        );
        let schema = knowledge_response_schema("note-routing", &too_many, &json!({})).unwrap();
        for field in ["noteId", "noteVersion"] {
            let string_schema = schema.pointer(&format!("{routes}/{field}")).unwrap();
            assert!(string_schema.get("enum").is_none());
            assert_eq!(string_schema.pointer("/maxLength"), Some(&json!(300)));
        }
        assert_eq!(
            schema.pointer("/properties/payload/properties/rangeId/enum"),
            Some(&json!(["notes-1"]))
        );
        assert_openai_strict_objects(&schema, "routing with an over-cap contract");

        let too_heavy = contract(
            (0..250)
                .map(|index| {
                    json!({
                        "noteId": format!("note-{index:0>276}"),
                        "noteVersion": "v-shared"
                    })
                })
                .collect(),
        );
        let schema = knowledge_response_schema("note-routing", &too_heavy, &json!({})).unwrap();
        assert!(schema.pointer(&format!("{routes}/noteId/enum")).is_none());
        assert_eq!(
            schema.pointer(&format!("{routes}/noteVersion/enum")),
            Some(&json!(["v-shared"]))
        );

        let malformed = contract(vec![json!({ "noteId": 7, "noteVersion": "v-1" })]);
        let schema = knowledge_response_schema("note-routing", &malformed, &json!({})).unwrap();
        assert!(schema.pointer(&format!("{routes}/noteId/enum")).is_none());
        assert_eq!(
            schema.pointer(&format!("{routes}/noteVersion/enum")),
            Some(&json!(["v-1"]))
        );
    }

    #[test]
    fn import_link_plan_schema_supports_phrases_and_typed_arguments() {
        let organizer = organizer_schema();
        assert_eq!(
            organizer.pointer("/properties/suggestedConnections/items/properties/kind/enum"),
            Some(&json!(["supports", "qualifies", "conflicts", "related"]))
        );
        let reading = knowledge_source_reading_schema();
        assert!(reading
            .pointer("/properties/synthesisSeeds/items/required")
            .unwrap()
            .as_array()
            .unwrap()
            .contains(&json!("linkPhrases")));
    }
}
