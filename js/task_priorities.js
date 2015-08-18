define(function(require) {
'use strict';

const logic = require('logic');

/**
 * Helper class for use by TaskManager that is in charge of maintaining the
 * priority queue of tasks that are currently ready for execution.
 *
 *
 * TODO: Implement exclusive resource support or give up.
 */
function TaskPriorities() {
  logic.defineScope(this, 'TaskPriorities');

  /**
   * Heap tracking our prioritized tasks/markers by priority.  This only
   * includes tasks/priorities that are not deferred awaiting the availability
   * of a resource or a timeout.
   */
  this._prioritizedTasks = new FibonacciHeap();

  /**
   * @type {Map<TaskId, HeapNode>}
   * Maps TaskIds to the HeapNode where they are contained as a value.  Used
   * for re-prioritization of complex tasks as their markers are updated as well
   * as for removal of tasks by `TaskResources` when resources are revoked.
   * Note that `_priorityTagToHeapNodes` directly maps priority tags for
   * priority tag updates.
   *
   * Entries are removed from this map as they are removed from the
   * FibonacciHeap.
   */
  this._taskIdToHeapNode = new Map();

  /**
   * @type {Map<PriorityTag, HeapNode[]>}
   * Maps priority tags to the FibonacciHeap nodes holding a simple wrappedTask
   * or a complex task marker.
   */
  this._priorityTagToHeapNodes = new Map();
  /**
   * @type {Map<PriorityOwner, Map<PriorityTag, PriorityBoost>>}
   * Maps owners to their current maps of priority tags and their relative
   * priority boosts.  (Positive numbers are a boost, negative numbers are a
   * penalty.)
   */
  this._priorityTagsByOwner = new Map();

  /**
   * Maps priority tags to the sum of all of the values in the maps stored in
   * _priorityTagsByOwner.  Keys/values are deleted when they go to zero.  This
   * is updated incrementally, not re-tallied.
   */
  this._summedPriorityTags = new Map();
}
TaskPriorities.prototype = {
  /**
   * Do we have any tasks that are ready to execute?
   */
  hasTasksToExecute: function() {
    return this._prioritizedTasks.isEmpty();
  },

  popNextAvailableTask: function() {
    let priorityNode = this._prioritizedTasks.extractMinimum();
    let taskThing = priorityNode.value;
    this._taskIdToHeapNode.delete(taskThing.id);
    this._cleanupTaskPriorityTracking(taskThing, priorityNode);

    return taskThing;
  },

  _computePriorityForTags: function(priorityTags) {
    let summedPriorityTags = this._summedPriorityTags;
    let priority = 0;
    for (let priorityTag of priorityTags) {
      priority += (summedPriorityTags.get(priorityTag) || 0);
    }
    return priority;
  },

  /**
   * Updates the priority boost tags associated with the given owningId, like
   * when the user changes what they're looking at.  Pass null to clear the
   * existing priority boost tags.
   *
   * @param {String} owningId
   *   A non-colliding identifier amongst the other priority users.  The
   *   tentative convention is to just use bridge handles or things prefixed
   *   with them since all priorities flow from explicit user action.
   * @param {Map} tagsWithValues
   *   A map whose keys are tag names and values are (positive) priority boosts
   *   for tasks/markers possessing that tag.  The Map must *not* be mutated
   *   after it is passed-in.  (We could be defensive about this, but all our
   *   callers should be in-GELAM so it shouldn't be hard to comply.)
   */
  setPriorityBoostTags: function(owningId, tagsWithValues) {
    // This is a 2-pass implementation:
    // 1) Accumulate per-task/marker priority deltas stored in a map.
    // 2) Apply those deltas to the priority heap.
    // We don't want to update the heap as we go because

    let existingValues = this._priorityTagsByOwner.get(owningId) || new Map();
    let newValues = tagsWithValues || new Map();
    let perThingDeltas = new Map();

    let summedPriorityTags = this._summedPriorityTags;
    let priorityTagToHeapNodes = this._priorityTagToHeapNodes;

    if (tagsWithValues) {
      this._priorityTagsByOwner.set(owningId, tagsWithValues);
    } else {
      this._priorityTagsByOwner.delete(owningId);
    }

    // -- Phase 1: accumulate deltas (and update sums)
    let applyDelta = (priorityTag, delta) => {
      // - update sum
      let newSum = (summedPriorityTags.get(priorityTag) || 0) + delta;
      if (newSum) {
        summedPriorityTags.set(priorityTag, newSum);
      } else {
        summedPriorityTags.delete(priorityTag);
      }

      // - per-taskthing deltas
      let nodes = priorityTagToHeapNodes.get(priorityTag);
      if (nodes) {
        for (let node of nodes) {
          let aggregateDelta = (perThingDeltas.get(node) || 0) + delta;
          perThingDeltas.set(node, aggregateDelta);
        }
      }
    };

    // - Iterate over newValues for new/changed values.
    for (let [priorityTag, newPriority] of newValues.items()) {
      let oldPriority = existingValues.get(priorityTag) || 0;
      let priorityDelta = newPriority - oldPriority;
      applyDelta(priorityTag, priorityDelta);
    }
    // - Iterate over existingValues for deletions
    for (let [priorityTag, oldPriority] of existingValues.items()) {
      if (newValues.has(priorityTag)) {
        continue;
      }
      applyDelta(priorityTag, -oldPriority);
    }

    // -- Phase 2: update the priority heap
    for (let [node, aggregateDelta] of perThingDeltas.values()) {
      // The heap allows us to reduce keys (Which, because we negate them, means
      // priority increases) efficiently, but otherwise we need to remove the
      // thing and re-add it.
      let newKey = node.key - aggregateDelta; // (the keys are negated!)
      this._reprioritizeHeapNode(node, newKey);
    }
  },


  /**
   * Helper to decide whether to use decreaseKey for a node or remove it and
   * re-add it.  Centralized because this seems easy to screw up.  All values
   * are in the key-space, which is just the negated priority.
   */
  _reprioritizeHeapNode: function(node, newKey) {
    let prioritizedTasks = this._prioritizedTasks;
    if (newKey < node.key) {
      prioritizedTasks.decreaseKey(node, newKey);
    } else if (newKey > node.key) {
      let taskThing = node.value;
      prioritizedTasks.delete(node);
      prioritizedTasks.insert(newKey, taskThing);
    } // we intentionally do nothing for a delta of 0
  },

  /**
   * Prioritize the task for execution in our priority-heap.
   *
   * @param {WrappedTask|TaskMarker} taskThing
   */
  prioritizeTaskThing: function(taskThing/*, sourceId */) {
    // WrappedTasks store the type on the plannedTask; TaskMarkers store it on
    // the root (they're simple/flat).
    let isTask = !taskThing.type;
    let priorityTags = isTask ? taskThing.plannedTask.priorityTags
                              : taskThing.priorityTags;
    let relPriority = (isTask ? taskThing.plannedTask.relPriority
                              : taskThing.relPriority) || 0;
    let priority = relPriority + this._computePriorityForTags(priorityTags);
    // it's a minheap, we negate keys
    let nodeKey = -priority;

    // -- The task may already exist.
    let priorityNode = this._taskIdToHeapNode.get(taskThing.id);
    if (priorityNode) {
      this._reprioritizeHeapNode(priorityNode, nodeKey);
      // Priorities may have changed, so remove the existing mappings
      let oldTaskThing = priorityNode.value;
      this._cleanupTaskPriorityTracking(oldTaskThing);
      // The task/marker will have been created from scratch, so we need to
      // update the actual value.
      priorityNode.value = taskThing;
    } else {
      priorityNode = this._prioritizedTasks.insert(nodeKey, taskThing);
      this._taskIdToHeapNode.set(taskThing.id, priorityNode);
    }
    // And establish the new priority tag mappings.
    this._setupTaskPriorityTracking(taskThing, priorityNode);
  },

  _setupTaskPriorityTracking: function(taskThing, priorityNode) {
    let isTask = !taskThing.type;
    let priorityTags = isTask ? taskThing.plannedTask.priorityTags
                              : taskThing.priorityTags;
    let priorityTagToHeapNodes = this._priorityTagToHeapNodes;
    if (priorityTags) {
      for (let priorityTag of priorityTags) {
        let nodes = priorityTagToHeapNodes.get(priorityTag);
        if (nodes) {
          nodes.push(priorityNode);
        } else {
          priorityTagToHeapNodes.set(priorityTag, [priorityNode]);
        }
      }
    }
  },

  _cleanupTaskPriorityTracking: function(taskThing, priorityNode) {
    let isTask = !taskThing.type;
    let priorityTags = isTask ? taskThing.plannedTask.priorityTags
                              : taskThing.priorityTags;

    let priorityTagToHeapNodes = this._priorityTagToHeapNodes;
    if (priorityTags) {
      for (let priorityTag of priorityTags) {
        let nodes = priorityTagToHeapNodes.get(priorityTag);
        if (nodes) {
          let idx = nodes.indexOf(priorityNode);
          if (idx !== -1) {
            nodes.splice(idx, 1);
          }
          if (nodes.length === 0) {
            priorityTagToHeapNodes.delete(priorityTag);
          }
        }
      }
    }
  },

  /**
   * Remove the TaskThing with the given id.
   */
  removeTaskThing: function(taskId) {
    let priorityNode = this._taskIdToHeapNode.get(taskId);
    if (priorityNode) {
      let taskThing = priorityNode.value;
      this._prioritizedTasks.delete(priorityNode);
      this._taskIdToHeapNode.delete(taskId);
      this._cleanupTaskPriorityTracking(taskThing, priorityNode);
    }
  },
};
return TaskPriorities;
});