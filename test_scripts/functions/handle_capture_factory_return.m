f1 = make_adder(5);
disp(f1(3));
disp(f1(10));

f2 = make_adder(100);
disp(f2(1));
disp(f1(2));

m = make_mul(3);
disp(m(7));

function h = make_adder(k)
  h = @(x) x + k;
end

function h = make_mul(k)
  h = @(x) x * k;
end
