# Baimiao Toolbox

This context names the file-processing concepts shared by the Plugin's local and remote workflows.

## Language

**Operation**:
A named PDF or media workflow selected by the user and executed through the Plugin.
_Avoid_: Command, action

**JSON Plan**:
A non-sensitive JSON object containing advanced options for one local **Operation**.
_Avoid_: Config file, payload

**Local Artifact Transaction**:
The lifecycle that stages an **Operation**'s outputs and publishes them only to new local paths
while preserving every input.
_Avoid_: Output writer, file helper

## Relationships

- An **Operation** may read one **JSON Plan**.
- A local **Operation** publishes zero or more outputs through one **Local Artifact Transaction**.
- A **Local Artifact Transaction** preserves every input and refuses every existing output path.

## Example dialogue

> **Dev:** "Can this **Operation** replace the source PDF when the **JSON Plan** requests it?"
> **Domain expert:** "No. Its **Local Artifact Transaction** must preserve the source and publish only to new paths."

## Flagged ambiguities

- "Plan" previously meant both CLI arguments and a JSON file; **JSON Plan** now means only the
  bounded, non-sensitive JSON object read from a file.
