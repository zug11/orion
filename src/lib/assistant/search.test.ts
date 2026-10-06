import { expect, it } from "vitest";
import { createEmptyVault } from "../../data/defaults";
import type { ChatEvidence, Note } from "../../types";
import { assistantSearchResult } from "./search";
it("returns stable scoped note citations without inventing source routes", () => {
  const space=createEmptyVault().spaces[0];
  space.notes=[{id:"n",title:"A note",body:"evidence",sourceIds:["s"],aliases:[],tags:[],conceptIds:[],summary:"",slug:"n",kind:"article",status:"ready",createdAt:"today",updatedAt:"today"} as Note];
  space.sources=[{id:"s",title:"Source",text:"evidence",kind:"text",importedAt:"today",noteIds:["n"]},{id:"unlinked",title:"Original",text:"evidence",kind:"text",importedAt:"today",noteIds:[]}];
  const evidence:ChatEvidence[]=[{id:"e1",kind:"source",entityId:"s",title:"Source",version:"v",start:0,end:8,text:"evidence",offsetUnit:"utf16"},{id:"e2",kind:"source",entityId:"unlinked",title:"Original",version:"v",start:0,end:8,text:"evidence",offsetUnit:"utf16"}];
  const result=assistantSearchResult(space,{reply:"One [1](#orion-evidence-e1). Two [2](#orion-evidence-e2).",evidence});
  expect(result.answer).toContain(`orion://open?space_id=${encodeURIComponent(space.workspace.id)}&note_id=n`);
  expect(result.answer).not.toContain("#orion-evidence");expect(result.answer).toContain("Two [2].");
  expect(result.evidence).toEqual([expect.objectContaining({notes:[expect.objectContaining({id:"n"})]}),expect.objectContaining({notes:[]})]);
});
