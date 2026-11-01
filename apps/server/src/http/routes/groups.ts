import { parseWith } from '../validate.js';
import { createGroupBodySchema, renameGroupBodySchema } from '@studi0/shared';
import * as groupsRepo from '../../db/repos/groups.js';
import { HttpError } from '../../util/errors.js';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../context.js';

export async function registerGroupRoutes(app: FastifyInstance, ctx: Ctx): Promise<void> {
  const { db } = ctx;

  app.get('/api/groups', async () => groupsRepo.listGroups(db).map(groupsRepo.groupToDto));

  /** The UNIQUE(name) constraint is the real gate — a lost check-then-act race maps to 409. */
  function asNameTaken(e: unknown, name: string): never {
    const msg = String((e as Error).message ?? '');
    if (/UNIQUE/i.test(msg)) throw new HttpError('NAME_TAKEN', `a group named "${name}" already exists`);
    throw e as Error;
  }

  app.post('/api/groups', async (req, reply) => {
    const { name } = parseWith(createGroupBodySchema, req.body);
    if (groupsRepo.getGroupByName(db, name)) {
      throw new HttpError('NAME_TAKEN', `a group named "${name}" already exists`);
    }
    let dto;
    try {
      dto = groupsRepo.groupToDto(groupsRepo.insertGroup(db, name));
    } catch (e) {
      asNameTaken(e, name);
    }
    return reply.code(201).send(dto);
  });

  app.patch('/api/groups/:id', async (req) => {
    const id = (req.params as { id: string }).id;
    const { name } = parseWith(renameGroupBodySchema, req.body);
    if (!groupsRepo.getGroup(db, id)) {
      throw new HttpError('GROUP_NOT_FOUND', `group ${id} not found`);
    }
    if (groupsRepo.getGroupByName(db, name)) {
      throw new HttpError('NAME_TAKEN', `a group named "${name}" already exists`);
    }
    try {
      groupsRepo.renameGroup(db, id, name);
    } catch (e) {
      asNameTaken(e, name);
    }
    return groupsRepo.groupToDto(groupsRepo.getGroup(db, id) as groupsRepo.GroupRowWithCount);
  });

  // subjects in the group become ungrouped; the subjects themselves never go
  app.delete('/api/groups/:id', async (req) => {
    const id = (req.params as { id: string }).id;
    if (!groupsRepo.getGroup(db, id)) {
      throw new HttpError('GROUP_NOT_FOUND', `group ${id} not found`);
    }
    groupsRepo.deleteGroup(db, id);
    return { ok: true };
  });
}
