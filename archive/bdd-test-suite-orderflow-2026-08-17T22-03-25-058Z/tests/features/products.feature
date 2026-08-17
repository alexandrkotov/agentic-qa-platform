Feature: products

  @happy_path @products
  Scenario: Create Product with valid data
    Given a unique product name is generated
    When I create a product with the generated name and price 29.99
    Then the product creation response status should be 201
    And the product should exist in the database with the generated name and price 29.99
    And the product should appear in the products list with the generated name

  @edge_case @products
  Scenario: Create Product with zero or negative price
    When I create a product named "Zero Price Product" with price 0
    Then the product creation response status should be 201
    When I attempt to create a product named "Negative Price Product" with price -5.00
    Then the product creation response should be a 400 validation error

  @happy_path @products
  Scenario: Delete product with no order items
    Given a product exists for deletion test with name "Deletable Product" and price 15.00
    And the product has no associated order items
    When I delete the product
    Then the product deletion response status should be 200
    And the product should no longer exist in the database

  @edge_case @products
  Scenario: Delete product used in existing order
    Given a customer exists for product deletion order test
    And a product exists for order item test with name "Product In Order" and price 25.00
    And an order exists using that product
    When I attempt to delete the product used in an order
    # TODO (unconfirmed): Report says "verify behavior" - assuming cascade delete or foreign key error; checking for non-200 response
    Then the product deletion response should indicate an error or the product should still exist

  @happy_path @products
  Scenario: Update product price
    Given a product exists for update test with name "Updatable Product" and price 50.00
    And an order exists with that product capturing unit price 50.00
    When I update the product price to 75.00
    Then the product update response status should be 200
    And the product in the database should have price 75.00
    And the existing order item should still have unit price 50.00
