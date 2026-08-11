User Acceptance Testing — OrderFlow Order Management
Prepared by: QA / Business stakeholder
Purpose: Confirm the order management workflow behaves as expected from a business user's point of view before sign-off.


Test Case 1 — Create a new order
Preconditions: An existing customer account and at least one product in the catalog.
Steps:
1. Open the order creation screen.
2. Select the customer.
3. Add one or more products with quantities.
4. Save the order.
Expected Result: The order is created and shown with status "Draft". It appears in the customer's order history.


Test Case 2 — Submit an order for processing
Preconditions: A saved order in "Draft" status exists.
Steps:
1. Open the draft order.
2. Click "Submit".
Expected Result: The order status changes to "Submitted". The order can no longer be edited or deleted.


Test Case 3 — Submitted orders are locked
Preconditions: An order in "Submitted" status exists.
Steps:
1. Open the submitted order.
Attempt to change its details or delete it.
Expected Result: No edit or delete option is available for the order. There is no way to move it back to "Draft".


Test Case 4 — Product price changes don't affect existing orders
Preconditions: An existing order that includes a specific product.
Steps:
Note the product's price shown on the order.
Go to the catalog and change that product's price.
Reopen the existing order.
Expected Result: The price shown on the order is unchanged — it still reflects the price at the time the order was placed, not the current catalog price.










Test Case 5 — Orders require a customer and at least one item
Preconditions: The order creation screen is open.
Steps:
Try to save an order without selecting a customer.
Try to save an order with no products added.
Expected Result: In both cases, the system refuses to save the order and shows an error instead of creating an empty or invalid one.


Sign-off: ☐ Approved ☐ Approved with comments ☐ Rejected