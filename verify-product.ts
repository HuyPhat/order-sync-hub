import { sequelize } from './src/db/sequelize.js';
import { Product } from './src/models/product.js';

const t = await sequelize.transaction();
try {
  const created = await Product.create(
    { sku: 'VERIFY-1', name: 'Verify', price: '19.99' },
    { transaction: t },
  );
  const found = await Product.findOne({ where: { sku: 'VERIFY-1' }, transaction: t });
  console.log('id is number:', typeof created.id === 'number', '| createdAt is Date:', created.createdAt instanceof Date);
  console.log('price read back:', JSON.stringify(found?.price), '| typeof:', typeof found?.price);
  const columns = Object.keys(await sequelize.getQueryInterface().describeTable('products')).sort();
  console.log('table columns:', JSON.stringify(columns));
  const attrs = Object.keys(Product.getAttributes()).sort();
  console.log('model attributes:', JSON.stringify(attrs));
  console.log('model matches table columns:', JSON.stringify(columns) === JSON.stringify(attrs));
  try {
    await Product.create({ sku: 'VERIFY-1', name: 'Dup', price: '1.00' }, { transaction: t });
  } catch (e) {
    console.log('duplicate sku ->', (e as Error).name);
  }
} finally {
  await t.rollback();
  await sequelize.close();
}
