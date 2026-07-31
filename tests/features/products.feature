Feature: products

  @happy_path @products
  Scenario: Create Product with valid data
    When an API request is sent for "products":
      """
      {
        "method": "POST",
        "path": "/products",
        "requestBody": {
          "name": "Test Product {{unique}}",
          "price": 49.99
        }
      }
      """
    Then the "products" response has this status code:
      """
      {
        "statusCode": 201
      }
      """
    And the "products" response body has this field:
      """
      {
        "field": "name",
        "expected": "Test Product {{unique}}"
      }
      """
    And the "products" response body has this field:
      """
      {
        "field": "price",
        "expected": "49.99"
      }
      """
    And the database has this row for "products":
      """
      {
        "table": "Product",
        "where": {
          "id": "{products.id}"
        },
        "expectedFields": {
          "name": "Test Product {{unique}}",
          "price": "49.99"
        }
      }
      """

  @edge_case @products
  Scenario: Create Product with zero or negative price
    # TODO (unconfirmed): Report does not explicitly state validation rules for zero/negative prices; assuming 400 error but actual behavior may differ
    When an API request is sent for "products":
      """
      {
        "method": "POST",
        "path": "/products",
        "requestBody": {
          "name": "Zero Price Product {{unique}}",
          "price": 0
        }
      }
      """
    Then the "products" response has this status code:
      """
      {
        "statusCode": 400
      }
      """

  @happy_path @products
  Scenario: Delete product with no order items
    Given an API request is sent for "products":
      """
      {
        "method": "POST",
        "path": "/products",
        "requestBody": {
          "name": "Deletable Product {{unique}}",
          "price": 15
        }
      }
      """
    When an API request is sent for "products":
      """
      {
        "method": "DELETE",
        "path": "/products/{id}",
        "requestBody": null
      }
      """
    Then the "products" response has this status code:
      """
      {
        "statusCode": 200
      }
      """

  @edge_case @products
  Scenario: Delete product used in existing order
    # TODO (unconfirmed): Report says 'verify behavior' for this case; assuming 409 conflict but could be 400 or cascading delete with 200
    Given an API request is sent for "products":
      """
      {
        "method": "POST",
        "path": "/customers",
        "requestBody": {
          "email": "product-delete-test-{{unique}}@example.com",
          "name": "Product Delete Test Customer"
        }
      }
      """
    And an API request is sent for "products":
      """
      {
        "method": "POST",
        "path": "/products",
        "requestBody": {
          "name": "Product In Order {{unique}}",
          "price": 25
        }
      }
      """
    And an API request is sent for "products":
      """
      {
        "method": "POST",
        "path": "/orders",
        "requestBody": {
          "customerId": "{customers.id}",
          "items": [
            {
              "productId": "{products.id}",
              "quantity": 1
            }
          ]
        }
      }
      """
    When an API request is sent for "products":
      """
      {
        "method": "DELETE",
        "path": "/products/{id}",
        "requestBody": null
      }
      """
    Then the "products" response has this status code:
      """
      {
        "statusCode": 409
      }
      """

  @happy_path @products
  Scenario: Update product price
    Given an API request is sent for "products":
      """
      {
        "method": "POST",
        "path": "/customers",
        "requestBody": {
          "email": "price-update-test-{{unique}}@example.com",
          "name": "Price Update Test Customer"
        }
      }
      """
    And an API request is sent for "products":
      """
      {
        "method": "POST",
        "path": "/products",
        "requestBody": {
          "name": "Price Update Product {{unique}}",
          "price": 100
        }
      }
      """
    And an API request is sent for "products":
      """
      {
        "method": "POST",
        "path": "/orders",
        "requestBody": {
          "customerId": "{customers.id}",
          "items": [
            {
              "productId": "{products.id}",
              "quantity": 2
            }
          ]
        }
      }
      """
    When an API request is sent for "products":
      """
      {
        "method": "PATCH",
        "path": "/products/{id}",
        "requestBody": {
          "price": 150
        }
      }
      """
    Then the "products" response has this status code:
      """
      {
        "statusCode": 200
      }
      """
    And the "products" response body has this field:
      """
      {
        "field": "price",
        "expected": "150"
      }
      """
    And the database has this row for "products":
      """
      {
        "table": "Product",
        "where": {
          "id": "{products.id}"
        },
        "expectedFields": {
          "price": "150"
        }
      }
      """
    And the database has this row for "products":
      """
      {
        "table": "OrderItem",
        "where": {
          "orderId": "{orders.id}"
        },
        "expectedFields": {
          "unitPrice": "100"
        }
      }
      """
