# Tanzu Marketplace Cloud Graphic Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a verified 2730 × 1536 PNG of the approved Tanzu Marketplace scene containing all 11 supplied high-resolution service logos.

**Architecture:** Use `_Marketplace_after.png` as the edit target and the 11 supplied logo files as compositing references in the built-in image-generation workflow. Preserve all scene elements outside the marketplace cloud, rebuild the service area to the approved 4–4–3 layout, then normalize the selected output to the required canvas dimensions and visually inspect it.

**Tech Stack:** Built-in image generation/editing, macOS image metadata and resizing utilities, Codex image inspection.

## Global Constraints

- Final PNG dimensions: exactly 2730 × 1536 pixels.
- Preserve the existing illustrated people, desks, monitors, cloud shell, background network motif, and `TANZU MARKETPLACE` heading.
- Use all 11 supplied service logos and the approved labels.
- Save non-destructively as `assets/tanzu-marketplace-cloud-hires.png`.

---

### Task 1: Render and Verify the Marketplace Graphic

**Files:**
- Read: `/Users/dbbaskette/Downloads/temp_demo_icons/_Marketplace_after.png`
- Read: `/Users/dbbaskette/Downloads/temp_demo_icons/PostgreSQL.jpeg`
- Read: `/Users/dbbaskette/Downloads/temp_demo_icons/valkey.png`
- Read: `/Users/dbbaskette/Downloads/temp_demo_icons/rabbitMQ.png`
- Read: `/Users/dbbaskette/Downloads/temp_demo_icons/MySQL.png`
- Read: `/Users/dbbaskette/Downloads/temp_demo_icons/GemFire.png`
- Read: `/Users/dbbaskette/Downloads/temp_demo_icons/Kafka.png`
- Read: `/Users/dbbaskette/Downloads/temp_demo_icons/DataFlow.png`
- Read: `/Users/dbbaskette/Downloads/temp_demo_icons/MCP_gateway.png`
- Read: `/Users/dbbaskette/Downloads/temp_demo_icons/API_gateway.png`
- Read: `/Users/dbbaskette/Downloads/temp_demo_icons/data-services-manager.png`
- Read: `/Users/dbbaskette/Downloads/temp_demo_icons/AI_models.png`
- Create: `assets/tanzu-marketplace-cloud-hires.png`

**Interfaces:**
- Consumes: approved graphic design and the 12 local image inputs listed above.
- Produces: a standalone PNG at `assets/tanzu-marketplace-cloud-hires.png`.

- [ ] **Step 1: Generate the composite**

  Use the built-in image editor with `_Marketplace_after.png` as the edit target and the 11 logo files as supporting compositing inputs. Request the exact approved 4–4–3 order, labels, invariants, and avoidance constraints.

- [ ] **Step 2: Inspect the first render**

  Confirm that all 11 service badges are present; all labels are accurate; the title and non-cloud scene remain intact; and no logo, badge, or label is cropped or distorted. If one focused defect exists, perform one targeted edit and inspect again.

- [ ] **Step 3: Save the selected render**

  Copy the selected generated PNG into `assets/tanzu-marketplace-cloud-hires.png`. Resize proportionally and crop only if necessary to restore the exact 2730 × 1536 canvas without changing the approved composition.

- [ ] **Step 4: Verify the deliverable**

  Inspect the final PNG and verify with image metadata that it is exactly 2730 × 1536, has a normal RGB/RGBA raster format, includes every approved service, and has no visible generation artifacts.

- [ ] **Step 5: Report the artifact**

  Provide the clickable absolute path, inline preview, final pixel dimensions, and the final generation prompt. Do not overwrite either source graphic.
