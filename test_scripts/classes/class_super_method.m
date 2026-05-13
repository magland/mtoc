% Child overrides parent method but reuses the parent's logic via a
% super-method call: `result = methodName@Parent(obj)`. mtoc routes
% this through Workspace.resolveForTargetClass with the parent class
% pinned, so the resolver delegates the dispatch decision to numbl.
classdef BaseShape
  properties
    side
  end
  methods
    function obj = BaseShape(s)
      obj.side = s;
    end
    function r = area(obj)
      r = obj.side * obj.side;
    end
  end
end

classdef ScaledShape < BaseShape
  methods
    function obj = ScaledShape(s)
      obj.side = s;
    end
    function r = area(obj)
      r = area@BaseShape(obj) * 10;
    end
  end
end

s = ScaledShape(3);
disp(s.area());
