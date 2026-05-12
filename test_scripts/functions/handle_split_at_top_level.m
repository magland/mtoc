f = @foo;
disp(f(3));
f = @bar;
disp(f(3));

function y = foo(x)
  y = x + 100;
end

function y = bar(x)
  y = x - 100;
end
