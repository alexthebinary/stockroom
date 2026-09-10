import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { contains } from "../search";
import { badRequest, notFound } from "../errors";
import { asyncHandler, intParam, pagination, parseBody } from "../http";

export const catalogsRouter = Router();

const partySchema = z.object({
  name: z.string().min(1),
  email: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  address: z.string().optional().nullable(),
  isActive: z.boolean().optional(),
});

/**
 * Customers, vendors and employees share one shape, so they share one factory.
 * Each is archived rather than deleted once referenced, per the scope.
 */
function partyRoutes(
  path: string,
  model: "customer" | "vendor" | "employee",
  countRefs: (id: number) => Promise<number>
) {
  catalogsRouter.get(
    `/${path}`,
    asyncHandler(async (req, res) => {
      const { page, pageSize, skip, take } = pagination(req.query as Record<string, unknown>);
      const search = String(req.query.search ?? "").trim();
      const activeOnly = req.query.activeOnly === "true";

      const where = {
        ...(activeOnly ? { isActive: true } : {}),
        ...(search ? { name: contains(search) } : {}),
      };

      const [total, data] = await Promise.all([
        (prisma[model] as any).count({ where }),
        (prisma[model] as any).findMany({ where, skip, take, orderBy: { name: "asc" } }),
      ]);
      res.json({ data, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
    })
  );

  catalogsRouter.get(
    `/${path}/:id`,
    asyncHandler(async (req, res) => {
      const id = intParam(req.params.id, "id");
      const row = await (prisma[model] as any).findUnique({ where: { id } });
      if (!row) throw notFound(`${path} record not found`);
      res.json(row);
    })
  );

  catalogsRouter.post(
    `/${path}`,
    asyncHandler(async (req, res) => {
      const data = parseBody(partySchema, req.body);
      res.status(201).json(await (prisma[model] as any).create({ data }));
    })
  );

  catalogsRouter.put(
    `/${path}/:id`,
    asyncHandler(async (req, res) => {
      const id = intParam(req.params.id, "id");
      const data = parseBody(partySchema.partial(), req.body);
      const existing = await (prisma[model] as any).findUnique({ where: { id } });
      if (!existing) throw notFound(`${path} record not found`);
      res.json(await (prisma[model] as any).update({ where: { id }, data }));
    })
  );

  catalogsRouter.delete(
    `/${path}/:id`,
    asyncHandler(async (req, res) => {
      const id = intParam(req.params.id, "id");
      const existing = await (prisma[model] as any).findUnique({ where: { id } });
      if (!existing) throw notFound(`${path} record not found`);

      if ((await countRefs(id)) === 0) {
        await (prisma[model] as any).delete({ where: { id } });
        res.json({ deleted: true, archived: false });
        return;
      }
      await (prisma[model] as any).update({ where: { id }, data: { isActive: false } });
      res.json({ deleted: true, archived: true });
    })
  );
}

partyRoutes("customers", "customer", async (id) =>
  (await prisma.salesOrder.count({ where: { customerId: id } })) +
  (await prisma.invoice.count({ where: { customerId: id } })) +
  (await prisma.payment.count({ where: { customerId: id } }))
);

partyRoutes("vendors", "vendor", async (id) =>
  (await prisma.purchaseOrder.count({ where: { vendorId: id } })) +
  (await prisma.bill.count({ where: { vendorId: id } })) +
  (await prisma.payment.count({ where: { vendorId: id } }))
);

partyRoutes("employees", "employee", async (id) =>
  (await prisma.salesOrder.count({ where: { employeeId: id } })) +
  (await prisma.purchaseOrder.count({ where: { employeeId: id } }))
);

// --- Product categories: a two-level tree, no deeper -----------------------

const categorySchema = z.object({
  name: z.string().min(1),
  parentId: z.number().int().positive().optional().nullable(),
  isActive: z.boolean().optional(),
});

catalogsRouter.get(
  "/product-categories",
  asyncHandler(async (_req, res) => {
    const rows = await prisma.productCategory.findMany({
      include: { children: { orderBy: { name: "asc" } }, _count: { select: { products: true } } },
      orderBy: { name: "asc" },
    });
    // Return the tree, so the client does not have to assemble it.
    res.json({ data: rows.filter((r) => r.parentId === null) });
  })
);

catalogsRouter.post(
  "/product-categories",
  asyncHandler(async (req, res) => {
    const data = parseBody(categorySchema, req.body);

    if (data.parentId) {
      const parent = await prisma.productCategory.findUnique({ where: { id: data.parentId } });
      if (!parent) throw notFound(`Category ${data.parentId} not found`);
      // Two levels only. SQLite cannot express this, so it is enforced here.
      if (parent.parentId !== null) {
        throw badRequest(
          `"${parent.name}" is already a subcategory — the category tree is two levels deep`
        );
      }
    }

    res.status(201).json(await prisma.productCategory.create({ data }));
  })
);

catalogsRouter.delete(
  "/product-categories/:id",
  asyncHandler(async (req, res) => {
    const id = intParam(req.params.id, "id");
    const existing = await prisma.productCategory.findUnique({
      where: { id },
      include: { children: true, products: true },
    });
    if (!existing) throw notFound("Category not found");
    if (existing.children.length > 0) {
      throw badRequest("Remove or move this category's subcategories first");
    }
    if (existing.products.length > 0) {
      await prisma.productCategory.update({ where: { id }, data: { isActive: false } });
      res.json({ deleted: true, archived: true });
      return;
    }
    await prisma.productCategory.delete({ where: { id } });
    res.json({ deleted: true, archived: false });
  })
);

// --- Transaction types and their posting templates -------------------------

catalogsRouter.get(
  "/accounts",
  asyncHandler(async (_req, res) => {
    const accounts = await prisma.account.findMany({ orderBy: { code: "asc" } });
    res.json({ data: accounts });
  })
);

catalogsRouter.get(
  "/journal-templates",
  asyncHandler(async (_req, res) => {
    const templates = await prisma.journalTemplate.findMany({ orderBy: { transactionType: "asc" } });
    const accounts = await prisma.account.findMany();
    const nameOf = (code: string) => accounts.find((a) => a.code === code)?.name ?? code;
    res.json({
      data: templates.map((t) => ({
        ...t,
        debitAccountName: nameOf(t.debitAccountCode),
        creditAccountName: nameOf(t.creditAccountCode),
      })),
    });
  })
);
