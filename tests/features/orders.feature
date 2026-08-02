Feature: orders

  @happy_path @orders
  Scenario: Submit DRAFT order
    Given a customer exists for order testing with email "order-submit@example.com" and name "Order Submit Tester"
    And a product exists for order testing with name "Submit Test Product" and price 45.00
    And a draft order exists for that customer with that product
    When I submit the draft order
    Then the order status should be "SUBMITTED"
    And the OrderStatusHistory table should have a "SUBMITTED" entry for that order

  @happy_path @orders
  Scenario: Verify Kafka event on order creation
    Given the Kafka consumer is ready for order status events
    And a customer exists for order testing with email "kafka-create@example.com" and name "Kafka Create Tester"
    And a product exists for order testing with name "Kafka Create Product" and price 30.00
    When I create a new order for that customer with that product
    Then a Kafka message should be published with status "DRAFT" for that order

  @happy_path @orders
  Scenario: Verify Kafka event on order submission
    Given the Kafka consumer is ready for order status events
    And a customer exists for order testing with email "kafka-submit@example.com" and name "Kafka Submit Tester"
    And a product exists for order testing with name "Kafka Submit Product" and price 55.00
    And a draft order exists for that customer with that product
    When I submit the draft order
    Then the order status in the database should be "SUBMITTED"
    And a Kafka message should be published with status "SUBMITTED" for that order

  @happy_path @orders
  Scenario: Delete DRAFT order
    Given a customer exists for order testing with email "delete-draft@example.com" and name "Delete Draft Tester"
    And a product exists for order testing with name "Delete Draft Product" and price 20.00
    And a draft order exists for that customer with that product
    When I delete the draft order
    Then the order deletion response should indicate success
    And the order should no longer exist in the Order table

  @edge_case @orders
  Scenario: Attempt to delete SUBMITTED order
    Given a customer exists for order testing with email "delete-submitted@example.com" and name "Delete Submitted Tester"
    And a product exists for order testing with name "Delete Submitted Product" and price 35.00
    And a submitted order exists for that customer with that product
    When I navigate to the orders page
    Then the submitted order should not have a Delete button

  @happy_path @orders
  Scenario: Edit DRAFT order items
    Given a customer exists for order editing with email "edit-order-customer@example.com" and name "Edit Order Customer"
    And a product exists for order editing with name "Original Product" and price 15.00
    And a second product exists for order editing with name "Replacement Product" and price 25.00
    And a draft order exists for order editing with the original product
    When I update the draft order items to use the replacement product with quantity 2
    Then the order items update response should indicate success
    And the order should have the replacement product with quantity 2 in the database

  @edge_case @orders
  Scenario: Attempt to edit SUBMITTED order
    Given a customer exists for submitted order edit test with email "submitted-edit-customer@example.com" and name "Submitted Edit Customer"
    And a product exists for submitted order edit test with name "Submitted Edit Product" and price 30.00
    And a submitted order exists for submitted order edit test
    When I attempt to update the submitted order items
    Then the order items update response should be a 409 conflict

  @happy_path @orders
  Scenario: Create order with quantity greater than 1
    Given a customer exists for quantity test with email "quantity-test-customer@example.com" and name "Quantity Test Customer"
    And a product exists for quantity test with name "Bulk Product" and price 12.50
    When I create an order for that customer with that product and quantity 3
    Then the order creation response should indicate success
    And the order item should have quantity 3 and unit price 12.50 in the database
    And the order item subtotal should be 37.50

  @edge_case @orders
  Scenario: API: Update order status with invalid status value
    Given a customer exists for invalid status test with email "invalid-status-customer@example.com" and name "Invalid Status Customer"
    And a product exists for invalid status test with name "Invalid Status Product" and price 20.00
    And a draft order exists for invalid status test
    When I send a PATCH request to update the order status to "CANCELLED"
    Then the order status update response should be a 400 validation error

  @happy_path @orders
  Scenario: Create Order with valid customer and items
    Given a customer exists for valid order creation with email "valid-order-customer@example.com" and name "Valid Order Customer"
    And a product exists for valid order creation with name "Valid Order Product" and price 45.00
    When I create a new order for that customer with that product and quantity 1
    Then the order creation response should indicate success
    And the order should exist in the Order table with status "DRAFT"
    And the OrderStatusHistory should have a "DRAFT" entry for the created order

  @edge_case @orders
  Scenario: Create Order without selecting a customer
    Given I am on the orders page for order creation
    And a product is available for order creation with name "Order Test Product" and price 15.99
    When I add the product "Order Test Product" to the order form
    And I click the Create Order button without selecting a customer
    Then the order creation should fail due to missing customer

  @edge_case @orders
  Scenario: Create Order without any items
    Given I am on the orders page for empty order test
    And a customer is available for empty order test with email "empty-order-test@example.com" and name "Empty Order Tester"
    When I select the customer "Empty Order Tester" for the order
    And I click the Create Order button without adding any items
    Then the order creation should fail due to missing items

  @happy_path @orders
  Scenario: Add multiple items to order
    Given a customer exists for multi-item order with email "multi-item-order@example.com" and name "Multi Item Customer"
    And a first product exists for multi-item order with name "Multi Item Product A" and price 25.00
    And a second product exists for multi-item order with name "Multi Item Product B" and price 35.50
    When I create an order with multiple items for that customer
    Then the order creation with multiple items should succeed
    And the order should contain 2 items in the database
    And the first order item should have product "Multi Item Product A" with quantity 1 and unit price 25.00
    And the second order item should have product "Multi Item Product B" with quantity 1 and unit price 35.50

  @edge_case @orders
  Scenario: API: Create order with invalid customerId
    Given a product exists for invalid customer order test with name "Invalid Customer Test Product" and price 10.00
    When I send a POST request to create an order with non-existent customerId 999999
    Then the order creation response should be a 400 or 404 error

  @edge_case @orders
  Scenario: API: Create order with invalid productId
    Given a customer exists for invalid product order test with email "invalid-product-order@example.com" and name "Invalid Product Tester"
    When I send a POST request to create an order with non-existent productId 999999
    Then the order creation response for invalid product should be a 400 or 404 error
