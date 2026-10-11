import { Order } from './order.js';
import { OrderItem } from './order-item.js';
import { Product } from './product.js';

// Associations live here, in one place, so no model file has to import another at runtime.
// Import models from this file whenever you need them associated.
Order.hasMany(OrderItem, { foreignKey: 'orderId', as: 'items' });
OrderItem.belongsTo(Order, { foreignKey: 'orderId', as: 'order' });
OrderItem.belongsTo(Product, { foreignKey: 'productId', as: 'product' });

export { Order, OrderItem, Product };
export type { OrderStatus } from './order.js';
